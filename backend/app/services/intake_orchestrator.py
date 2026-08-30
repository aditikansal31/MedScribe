"""
Runs AI-assisted vitals extraction, correctly scoped to ONLY
NURSE_INTAKE-stage recordings for the appointment -- not doctor-
consultation recordings, per the real two-recording clinical workflow
(added in this same work session after the initial version incorrectly
pulled from all transcripts regardless of which recording/stage they
came from).
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession as DBSession

from app.core.logging_config import get_logger
from app.models.audio import AudioChunk, AudioRecording
from app.models.enums import InputSource, RecordingStage
from app.models.intake_form import IntakeForm
from app.models.transcript import Transcript
from app.services.audio_service import AudioValidationError
from app.services.intake_prompt_builder import build_intake_extraction_prompt
from app.services.medgemma_service import MODEL_ID, MODEL_VERSION, generate_draft

logger = get_logger(__name__)


async def run_intake_draft_pipeline(
    appointment_id: uuid.UUID, nurse_id: uuid.UUID, db: DBSession
) -> IntakeForm:
    # Only transcripts belonging to chunks of NURSE_INTAKE-stage
    # recordings for this appointment -- explicit join, not a blanket
    # appointment_id filter, per the real two-recording workflow.
    transcripts_result = await db.execute(
        select(Transcript)
        .join(AudioChunk, Transcript.audio_chunk_id == AudioChunk.id)
        .join(AudioRecording, AudioChunk.audio_recording_id == AudioRecording.id)
        .where(
            AudioRecording.appointment_id == appointment_id,
            AudioRecording.recording_stage == RecordingStage.NURSE_INTAKE,
        )
    )
    transcripts = transcripts_result.scalars().all()

    if not transcripts:
        raise AudioValidationError(
            "No nurse-intake-stage transcripts found for this appointment. "
            "Ensure a recording was uploaded with recording_stage=nurse_intake "
            "and has been transcribed."
        )

    prompt = build_intake_extraction_prompt(list(transcripts))
    draft_result = await generate_draft(prompt)

    intake_form = IntakeForm(
        appointment_id=appointment_id,
        nurse_id=nurse_id,
        source_entity_set_id=None,
        input_source=InputSource.LIVE_RECORDING,
        # form_data is the RAW extraction text for now -- structured
        # parsing (mirroring Phase 13's prescription_draft_parser.py
        # pattern) is real, separate follow-up work, not built in this
        # pass. Storing the raw quoted-extraction text is itself
        # useful and human-reviewable, even unparsed, given the
        # traceability the prompt now requires.
        form_data={
            "ai_generated": True,
            "ai_model_name": MODEL_ID,
            "ai_model_version": MODEL_VERSION,
            "ai_raw_draft_text": draft_result.text,
            "vitals": {},
            "prior_test_results": [],
            "reason_for_visit": None,
            "known_allergies": None,
        },
        is_final=False,
    )
    db.add(intake_form)
    await db.commit()
    await db.refresh(intake_form)

    logger.info(
        "intake_draft_created",
        appointment_id=str(appointment_id),
        intake_form_id=str(intake_form.id),
        generation_seconds=round(draft_result.generation_seconds, 1),
    )
    return intake_form