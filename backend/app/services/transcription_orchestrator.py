"""
Runs MedASR over every chunk of a recording and persists one Transcript
row per chunk (source=local_asr, status=draft). Confidence scoring and
quality assessment are explicitly Phase 10's job -- this phase only
produces the raw draft transcripts for the quality engine to later
evaluate.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession as DBSession

from app.core.logging_config import get_logger
from app.models.audio import AudioChunk, AudioRecording
from app.models.enums import AudioProcessingStatus, HitlStatus, TranscriptSource, TranscriptStatus
from app.models.hitl import HitlItem
from app.models.transcript import Transcript
from app.services.audio_service import AudioValidationError, resolve_absolute_path
from app.services.medasr_service import MODEL_ID, transcribe_chunk
from app.services.quality_engine import assess_transcript_quality

logger = get_logger(__name__)

MODEL_VERSION = "1.0.0"  # per MedASR's own model card ("Model version: 1.0.0")


async def run_transcription_pipeline(recording_id: uuid.UUID, db: DBSession) -> list[Transcript]:
    result = await db.execute(select(AudioRecording).where(AudioRecording.id == recording_id))
    recording = result.scalar_one_or_none()
    if recording is None:
        raise AudioValidationError("Audio recording not found")

    if recording.processing_status != AudioProcessingStatus.CHUNKING_COMPLETE:
        raise AudioValidationError(
            f"Recording must be in chunking_complete status to transcribe "
            f"(currently: {recording.processing_status.value})"
        )

    chunks_result = await db.execute(
        select(AudioChunk)
        .where(AudioChunk.audio_recording_id == recording_id)
        .order_by(AudioChunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()

    if not chunks:
        raise AudioValidationError("No chunks found for this recording -- run chunking first")

    # Idempotent re-run, same pattern as chunking: clear any existing
    # LOCAL_ASR draft transcripts for this appointment's chunks before
    # regenerating, rather than accumulating duplicates on retry.
    existing_result = await db.execute(
        select(Transcript).where(
            Transcript.audio_chunk_id.in_([c.id for c in chunks]),
            Transcript.source == TranscriptSource.LOCAL_ASR,
        )
    )
    for stale in existing_result.scalars().all():
        await db.delete(stale)
    await db.flush()

    recording.processing_status = AudioProcessingStatus.TRANSCRIBING
    await db.commit()

    try:
        created_transcripts: list[Transcript] = []
        hitl_items_created = 0

        for chunk in chunks:
            chunk_absolute_path = resolve_absolute_path(chunk.storage_path)
            asr_result = await transcribe_chunk(chunk_absolute_path)

            chunk_duration = chunk.end_time_seconds - chunk.start_time_seconds
            quality_report = assess_transcript_quality(
                text=asr_result.text,
                mean_confidence=asr_result.confidence_score,
                min_confidence=asr_result.min_token_confidence,
                chunk_duration_seconds=chunk_duration,
            )

            transcript_status = TranscriptStatus.DRAFT if quality_report.accept else TranscriptStatus.FLAGGED_FOR_REVIEW

            transcript = Transcript(
                appointment_id=recording.appointment_id,
                audio_chunk_id=chunk.id,
                source=TranscriptSource.LOCAL_ASR,
                status=transcript_status,
                text=asr_result.text,
                model_name=MODEL_ID,
                model_version=MODEL_VERSION,
                confidence_score=asr_result.confidence_score,
                quality_report=quality_report.to_dict(),
            )
            db.add(transcript)
            await db.flush()  # need transcript.id for the HITL FK below
            created_transcripts.append(transcript)

            logger.info(
                "chunk_transcribed",
                recording_id=str(recording_id),
                chunk_index=chunk.chunk_index,
                text_length=len(asr_result.text),
                accept=quality_report.accept,
            )

            if not quality_report.accept:
                # One reason per HITL item, per the schema's design --
                # if multiple flags fired, we create one HITL entry per
                # flag rather than trying to encode multiple reasons on
                # a single row. This keeps each queue item's reason field
                # meaningful and matches the admin UI's existing
                # single-reason-per-card display (built in Phase 6).
                for flag_reason in quality_report.flags:
                    hitl_item = HitlItem(
                        appointment_id=recording.appointment_id,
                        transcript_id=transcript.id,
                        reason=flag_reason,
                        status=HitlStatus.PENDING,
                        detail=quality_report.to_dict(),
                        user_facing_message=(
                            f"Chunk {chunk.chunk_index} transcript flagged for review "
                            f"({flag_reason.value.replace('_', ' ')}). "
                            f"Speaker: {chunk.speaker_label or 'unknown'}."
                        ),
                    )
                    db.add(hitl_item)
                    hitl_items_created += 1

        recording.processing_status = AudioProcessingStatus.TRANSCRIPTION_COMPLETE
        await db.commit()

        for t in created_transcripts:
            await db.refresh(t)

        logger.info(
            "transcription_pipeline_complete",
            recording_id=str(recording_id),
            transcripts_created=len(created_transcripts),
            hitl_items_created=hitl_items_created,
        )
        return created_transcripts

    except Exception as exc:
        recording.processing_status = AudioProcessingStatus.TRANSCRIPTION_FAILED
        await db.commit()
        logger.error("transcription_pipeline_failed", recording_id=str(recording_id), error=str(exc))
        raise