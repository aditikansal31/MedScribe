import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import * as appointmentsApi from "../api/appointments";
import * as pipelineApi from "../api/pipeline";
import type { Appointment } from "../types/appointment";
import type { AudioRecording, AudioChunk } from "../types/audio";
import type { TranscriptWithQuality, ExtractedEntitySetFull } from "../types/transcriptExtended";
import { ApiError } from "../api/client";
import styles from "./AppointmentDetailPage.module.css";
import * as prescriptionsApi from "../api/prescriptions";
import * as intakeFormsApi from "../api/intakeForms";
import type { Prescription, PrescriptionData } from "../types/prescription";
import type { IntakeForm, IntakeFormData, VitalSigns } from "../types/intakeForm";

type SectionKey = "audio" | "chunks" | "transcripts" | "entities" | "prescription" | "intake";

function badgeClassFor(status: string): string {
  if (["transcription_complete", "chunking_complete"].includes(status)) return styles.stageComplete;
  if (status.includes("failed")) return styles.stageFailed;
  if (["validating", "normalizing", "chunking", "transcribing"].includes(status)) return styles.stageInProgress;
  return styles.stagePending;
}

export function AppointmentDetailPage() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const { user } = useAuth();

  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [recordings, setRecordings] = useState<AudioRecording[]>([]);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(["audio"]));
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadAppointment = useCallback(async () => {
    if (!appointmentId) return;
    try {
      const [appt, recs] = await Promise.all([
        appointmentsApi.getAppointment(appointmentId),
        pipelineApi.listRecordings(appointmentId),
      ]);
      setAppointment(appt);
      setRecordings(recs);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to load appointment.");
    } finally {
      setIsLoading(false);
    }
  }, [appointmentId]);

  useEffect(() => {
    loadAppointment();
  }, [loadAppointment]);

  function toggleSection(key: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (isLoading) {
    return (
      <AppShell>
        <div className={styles.loadingNote}>Loading appointment...</div>
      </AppShell>
    );
  }

  if (!appointment) {
    return (
      <AppShell>
        <div className={styles.errorBanner}>{error || "Appointment not found."}</div>
      </AppShell>
    );
  }

  const primaryRecording = recordings[0] ?? null;

  return (
    <AppShell>
      <div className={styles.header}>
        <div className={styles.breadcrumb}>
          <Link to={user?.role === "doctor" ? "/doctor" : "/nurse"}>Overview</Link> / Appointment
        </div>
        <h1>Appointment</h1>
        <div className={styles.appointmentMeta}>
          <span>Status: {appointment.status.replace(/_/g, " ")}</span>
          {appointment.chief_complaint && <span>Chief complaint: {appointment.chief_complaint}</span>}
        </div>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <AudioSection
        appointmentId={appointment.id}
        recordings={recordings}
        isOpen={openSections.has("audio")}
        onToggle={() => toggleSection("audio")}
        onRecordingsChanged={loadAppointment}
      />

      {primaryRecording && (
        <>
          <ChunkingSection
            recording={primaryRecording}
            isOpen={openSections.has("chunks")}
            onToggle={() => toggleSection("chunks")}
            onChanged={loadAppointment}
          />
          <TranscriptionSection
            recording={primaryRecording}
            isOpen={openSections.has("transcripts")}
            onToggle={() => toggleSection("transcripts")}
          />
          <EntitiesSection
            recording={primaryRecording}
            isOpen={openSections.has("entities")}
            onToggle={() => toggleSection("entities")}
          />
        </>
      )}

      <PrescriptionSection
        appointmentId={appointment.id}
        isOpen={openSections.has("prescription")}
        onToggle={() => toggleSection("prescription")}
      />

      <IntakeFormSection
        appointmentId={appointment.id}
        isOpen={openSections.has("intake")}
        onToggle={() => toggleSection("intake")}
      />
    </AppShell>
  );
}

// ============ Section: Audio upload/recording ============

interface AudioSectionProps {
  appointmentId: string;
  recordings: AudioRecording[];
  isOpen: boolean;
  onToggle: () => void;
  onRecordingsChanged: () => void;
}

function AudioSection({ appointmentId, recordings, isOpen, onToggle, onRecordingsChanged }: AudioSectionProps) {
  const [stage, setStage] = useState<"nurse_intake" | "doctor_consultation">("doctor_consultation");
  const [isUploading, setIsUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setError(null);
    try {
      await pipelineApi.uploadAudioFile(appointmentId, file, stage);
      onRecordingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
        setIsUploading(true);
        try {
          await pipelineApi.uploadLiveRecording(appointmentId, blob, stage);
          onRecordingsChanged();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Recording upload failed.");
        } finally {
          setIsUploading(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError("Could not access microphone. Check browser permissions.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>1. Audio Recording</span>
          <span className={`${styles.stageBadge} ${recordings.length > 0 ? styles.stageComplete : styles.stagePending}`}>
            {recordings.length > 0 ? `${recordings.length} recording(s)` : "No audio yet"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.actionRow}>
            <select
              className={styles.stageSelect}
              value={stage}
              onChange={(e) => setStage(e.target.value as "nurse_intake" | "doctor_consultation")}
            >
              <option value="doctor_consultation">Doctor consultation</option>
              <option value="nurse_intake">Nurse intake (vitals)</option>
            </select>

            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={handleFileUpload}
            />
            <button
              className={styles.secondaryButton}
              disabled={isUploading || isRecording}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? "Uploading..." : "Upload audio file"}
            </button>

            {!isRecording ? (
              <button className={styles.primaryButton} disabled={isUploading} onClick={startRecording}>
                ● Start recording
              </button>
            ) : (
              <button className={styles.recordButton} onClick={stopRecording}>
                ■ Stop & upload
              </button>
            )}
          </div>

          {recordings.length > 0 && (
            <div>
              {recordings.map((r) => (
                <div key={r.id} className={styles.itemCard}>
                  <div className={styles.itemMeta}>
                    {r.original_filename || "Live recording"} · {r.input_source.replace(/_/g, " ")} ·{" "}
                    {r.duration_seconds ? `${r.duration_seconds.toFixed(1)}s` : "duration unknown"}
                  </div>
                  <span className={`${styles.stageBadge} ${badgeClassFor(r.processing_status)}`}>
                    {r.processing_status.replace(/_/g, " ")}
                  </span>
                  {r.validation_failure_reason && (
                    <div className={styles.errorBanner} style={{ marginTop: "0.5rem" }}>
                      {r.validation_failure_reason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ Section: Chunking ============

interface ChunkingSectionProps {
  recording: AudioRecording;
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}

function ChunkingSection({ recording, isOpen, onToggle, onChanged }: ChunkingSectionProps) {
  const [chunks, setChunks] = useState<AudioChunk[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const loadChunks = useCallback(async () => {
    try {
      const data = await pipelineApi.listChunks(recording.id);
      setChunks(data);
    } catch {
      // Not fatal -- recording may not be chunked yet.
    } finally {
      setHasLoaded(true);
    }
  }, [recording.id]);

  useEffect(() => {
    if (isOpen && !hasLoaded) loadChunks();
  }, [isOpen, hasLoaded, loadChunks]);

  async function handleChunk() {
    setIsProcessing(true);
    setError(null);
    try {
      const data = await pipelineApi.chunkRecording(recording.id);
      setChunks(data);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Chunking failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  const canChunk = recording.processing_status === "uploaded";

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>2. Chunking (VAD + Speaker Diarization)</span>
          <span className={`${styles.stageBadge} ${chunks.length > 0 ? styles.stageComplete : styles.stagePending}`}>
            {chunks.length > 0 ? `${chunks.length} chunks` : "Not chunked"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.actionRow}>
            <button className={styles.primaryButton} disabled={isProcessing || !canChunk} onClick={handleChunk}>
              {isProcessing ? "Processing (this can take several minutes)..." : "Run chunking"}
            </button>
            {!canChunk && chunks.length === 0 && (
              <span className={styles.pendingNote}>Recording must finish uploading/normalizing first.</span>
            )}
          </div>

          {isProcessing && (
            <p className={styles.loadingNote}>
              Running voice activity detection and speaker diarization -- this genuinely takes
              a few minutes on this hardware. Please don't close this tab.
            </p>
          )}

          {chunks.length > 0 && (
            <div>
              {chunks.map((c) => (
                <div key={c.id} className={styles.itemCard}>
                  <div className={styles.itemMeta}>
                    Chunk {c.chunk_index} · {c.start_time_seconds.toFixed(1)}s – {c.end_time_seconds.toFixed(1)}s ·
                    Speaker: {c.speaker_label || "unknown"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ Section: Transcription ============

interface TranscriptionSectionProps {
  recording: AudioRecording;
  isOpen: boolean;
  onToggle: () => void;
}

function TranscriptionSection({ recording, isOpen, onToggle }: TranscriptionSectionProps) {
  const [transcripts, setTranscripts] = useState<TranscriptWithQuality[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await pipelineApi.listTranscripts(recording.id);
      setTranscripts(data);
    } catch {
      // not fatal
    } finally {
      setHasLoaded(true);
    }
  }, [recording.id]);

  useEffect(() => {
    if (isOpen && !hasLoaded) load();
  }, [isOpen, hasLoaded, load]);

  async function handleTranscribe() {
    setIsProcessing(true);
    setError(null);
    try {
      const data = await pipelineApi.transcribeRecording(recording.id);
      setTranscripts(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Transcription failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  const canTranscribe = recording.processing_status === "chunking_complete";
  const flaggedCount = transcripts.filter((t) => t.status === "flagged_for_review").length;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>3. Transcription</span>
          <span className={`${styles.stageBadge} ${transcripts.length > 0 ? styles.stageComplete : styles.stagePending}`}>
            {transcripts.length > 0
              ? `${transcripts.length} transcripts${flaggedCount > 0 ? `, ${flaggedCount} flagged` : ""}`
              : "Not transcribed"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.actionRow}>
            <button className={styles.primaryButton} disabled={isProcessing || !canTranscribe} onClick={handleTranscribe}>
              {isProcessing ? "Transcribing (MedASR + Azure, several minutes)..." : "Run transcription"}
            </button>
            {!canTranscribe && transcripts.length === 0 && (
              <span className={styles.pendingNote}>Chunking must complete first.</span>
            )}
          </div>

          {transcripts.map((t) => (
            <div key={t.id} className={styles.itemCard}>
              <div className={styles.itemMeta}>
                {t.source.replace(/_/g, " ")} · confidence: {t.confidence_score !== null ? t.confidence_score.toFixed(2) : "—"} ·{" "}
                {t.status === "flagged_for_review" ? "⚠ flagged for review" : "accepted"}
              </div>
              <div className={`${styles.itemText} ${t.status === "flagged_for_review" ? styles.flaggedText : ""}`}>
                {t.text || <em>(empty)</em>}
              </div>
              {t.quality_report && (
                <button
                  className={styles.secondaryButton}
                  style={{ marginTop: "0.5rem", fontSize: "0.78rem", padding: "0.3rem 0.7rem" }}
                  onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                >
                  {expandedId === t.id ? "Hide" : "Show"} quality details
                </button>
              )}
              {expandedId === t.id && t.quality_report && (
                <pre
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.75rem",
                    background: "var(--color-bg)",
                    padding: "0.6rem",
                    borderRadius: "var(--radius-sm)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {JSON.stringify(t.quality_report, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Section: Extracted Entities ============

interface EntitiesSectionProps {
  recording: AudioRecording;
  isOpen: boolean;
  onToggle: () => void;
}

function EntitiesSection({ recording, isOpen, onToggle }: EntitiesSectionProps) {
  const [entitySets, setEntitySets] = useState<ExtractedEntitySetFull[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await pipelineApi.listEntities(recording.id);
      setEntitySets(data);
    } catch {
      // not fatal
    } finally {
      setHasLoaded(true);
    }
  }, [recording.id]);

  useEffect(() => {
    if (isOpen && !hasLoaded) load();
  }, [isOpen, hasLoaded, load]);

  async function handleExtract() {
    setIsProcessing(true);
    setError(null);
    try {
      const data = await pipelineApi.extractEntities(recording.id);
      setEntitySets(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Entity extraction failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  const totalAccepted = entitySets.reduce((sum, e) => sum + (e.validated_entities?.accepted_count ?? 0), 0);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>4. Extracted Entities</span>
          <span className={`${styles.stageBadge} ${entitySets.length > 0 ? styles.stageComplete : styles.stagePending}`}>
            {entitySets.length > 0 ? `${totalAccepted} accepted entities` : "Not extracted"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.actionRow}>
            <button className={styles.primaryButton} disabled={isProcessing} onClick={handleExtract}>
              {isProcessing ? "Extracting entities..." : "Run entity extraction"}
            </button>
          </div>

          {entitySets.map((set) => {
            const entities = set.validated_entities?.entities || [];
            if (entities.length === 0) return null;
            return (
              <div key={set.id} className={styles.itemCard}>
                {entities.map((e, i) => (
                  <span
                    key={i}
                    className={`${styles.entityTag} ${e.status === "accepted" ? styles.entityAccepted : styles.entityRejected}`}
                    title={e.rejection_reason || undefined}
                  >
                    {e.text} ({e.label})
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
// ============ Section: Prescription (doctor) ============

interface PrescriptionSectionProps {
  appointmentId: string;
  isOpen: boolean;
  onToggle: () => void;
}

function PrescriptionSection({ appointmentId, isOpen, onToggle }: PrescriptionSectionProps) {
  const { user } = useAuth();
  const [prescription, setPrescription] = useState<Prescription | null>(null);
  const [editedData, setEditedData] = useState<PrescriptionData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAttempted, setHasAttempted] = useState(false);

  async function handleDraft() {
    setIsProcessing(true);
    setError(null);
    try {
      const result = await pipelineApi.draftPrescription(appointmentId);
      setPrescription(result);
      setEditedData(result.form_data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Drafting failed.");
    } finally {
      setIsProcessing(false);
      setHasAttempted(true);
    }
  }

  async function handleSave() {
    if (!prescription || !editedData) return;
    setIsProcessing(true);
    setError(null);
    try {
      const updated = await prescriptionsApi.updatePrescription(prescription.id, editedData);
      setPrescription(updated);
      setEditedData(updated.form_data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Save failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleFinalize() {
    if (!prescription) return;
    setIsProcessing(true);
    setError(null);
    try {
      const updated = await prescriptionsApi.finalizePrescription(prescription.id);
      setPrescription(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Finalization failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  const isDoctor = user?.role === "doctor";

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>5. Prescription (Doctor)</span>
          <span className={`${styles.stageBadge} ${prescription?.is_final ? styles.stageComplete : styles.stagePending}`}>
            {prescription ? (prescription.is_final ? "Finalized" : "Draft") : "Not started"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          {!isDoctor && (
            <p className={styles.pendingNote}>Only doctors can draft or edit prescriptions.</p>
          )}

          {isDoctor && !prescription && (
            <div className={styles.actionRow}>
              <button className={styles.primaryButton} disabled={isProcessing} onClick={handleDraft}>
                {isProcessing ? "Drafting (MedGemma, ~1-2 minutes)..." : "Draft prescription with AI"}
              </button>
              {hasAttempted && !isProcessing && !error && (
                <span className={styles.pendingNote}>No draft yet -- try again above.</span>
              )}
            </div>
          )}

          {editedData && prescription && (
            <>
              {editedData.ai_generated && (
                <div className={styles.aiDisclosure}>
                  AI-drafted by {editedData.ai_model_name}. Review and edit before finalizing --
                  this draft requires independent clinical verification.
                </div>
              )}
              {prescription.is_final && <div className={styles.finalBadge}>Finalized</div>}

              <div className={styles.formField} style={{ marginBottom: "1rem" }}>
                <label className={styles.label}>Problem Summary</label>
                <textarea
                  className={styles.textarea}
                  value={editedData.problem_summary}
                  disabled={prescription.is_final}
                  onChange={(e) => setEditedData({ ...editedData, problem_summary: e.target.value })}
                />
              </div>

              <StringListEditor
                label="Symptoms"
                items={editedData.symptoms}
                disabled={prescription.is_final}
                onChange={(items) => setEditedData({ ...editedData, symptoms: items })}
              />
              <StringListEditor
                label="Existing Conditions"
                items={editedData.existing_conditions}
                disabled={prescription.is_final}
                onChange={(items) => setEditedData({ ...editedData, existing_conditions: items })}
              />

              <div className={styles.label} style={{ marginBottom: "0.4rem", marginTop: "1rem" }}>Medications</div>
              <div className={styles.listEditor}>
                {editedData.medications.map((med, i) => (
                  <div key={i} className={styles.listRow}>
                    <input
                      className={styles.input}
                      style={{ flex: 1 }}
                      value={med.name}
                      disabled={prescription.is_final}
                      onChange={(e) => {
                        const meds = [...editedData.medications];
                        meds[i] = { ...meds[i], name: e.target.value };
                        setEditedData({ ...editedData, medications: meds });
                      }}
                    />
                    {!prescription.is_final && (
                      <button
                        className={styles.removeItemButton}
                        onClick={() => setEditedData({ ...editedData, medications: editedData.medications.filter((_, idx) => idx !== i) })}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!prescription.is_final && (
                  <button
                    className={styles.addItemButton}
                    onClick={() =>
                      setEditedData({
                        ...editedData,
                        medications: [...editedData.medications, { name: "", dosage: null, frequency: null, duration: null, instructions: null }],
                      })
                    }
                  >
                    + Add medication
                  </button>
                )}
              </div>

              <StringListEditor
                label="Advice"
                items={editedData.advice}
                disabled={prescription.is_final}
                onChange={(items) => setEditedData({ ...editedData, advice: items })}
              />
              <StringListEditor
                label="Follow-up"
                items={editedData.follow_up}
                disabled={prescription.is_final}
                onChange={(items) => setEditedData({ ...editedData, follow_up: items })}
              />

              {!prescription.is_final && isDoctor && (
                <div className={styles.actionRow}>
                  <button className={styles.secondaryButton} disabled={isProcessing} onClick={handleSave}>
                    Save changes
                  </button>
                  <button className={styles.primaryButton} disabled={isProcessing} onClick={handleFinalize}>
                    Finalize prescription
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Reusable simple string-list editor -- used for symptoms/conditions/
// advice/follow-up, which all share the same "list of plain strings,
// add/remove/edit" shape.
function StringListEditor({
  label,
  items,
  disabled,
  onChange,
}: {
  label: string;
  items: string[];
  disabled: boolean;
  onChange: (items: string[]) => void;
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div className={styles.label} style={{ marginBottom: "0.4rem" }}>{label}</div>
      <div className={styles.listEditor}>
        {items.map((item, i) => (
          <div key={i} className={styles.listRow}>
            <input
              className={styles.input}
              style={{ flex: 1 }}
              value={item}
              disabled={disabled}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            {!disabled && (
              <button className={styles.removeItemButton} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>
                ×
              </button>
            )}
          </div>
        ))}
        {!disabled && (
          <button className={styles.addItemButton} onClick={() => onChange([...items, ""])}>
            + Add
          </button>
        )}
      </div>
    </div>
  );
}

// ============ Section: Intake Form (nurse) ============

interface IntakeFormSectionProps {
  appointmentId: string;
  isOpen: boolean;
  onToggle: () => void;
}

function IntakeFormSection({ appointmentId, isOpen, onToggle }: IntakeFormSectionProps) {
  const { user } = useAuth();
  const [form, setForm] = useState<IntakeForm | null>(null);
  const [editedData, setEditedData] = useState<IntakeFormData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emptyFormData: IntakeFormData = {
    vitals: {
      blood_pressure_systolic: null,
      blood_pressure_diastolic: null,
      height_cm: null,
      weight_kg: null,
      temperature_celsius: null,
      pulse_bpm: null,
    },
    prior_test_results: [],
    reason_for_visit: null,
    known_allergies: null,
    ai_generated: false,
    ai_model_name: null,
    ai_model_version: null,
    ai_raw_draft_text: null,
  };

  useEffect(() => {
    let cancelled = false;

    async function loadIntakeForm() {
      setIsProcessing(true);
      setError(null);

      try {
        const existing = await intakeFormsApi.getIntakeFormForAppointment(
          appointmentId
        );

        if (!cancelled) {
          setForm(existing);
          setEditedData(existing.form_data);
        }
      } catch (err) {
        if (cancelled) return;

        // No existing form is normal for a new appointment.
        if (err instanceof ApiError && err.status === 404) {
          setForm(null);
          setEditedData(null);
        } else {
          setError(
            err instanceof ApiError
              ? err.detail
              : "Failed to load intake form."
          );
        }
      } finally {
        if (!cancelled) {
          setIsProcessing(false);
        }
      }
    }

    loadIntakeForm();

    return () => {
      cancelled = true;
    };
  }, [appointmentId]);  

  async function handleStartManual() {
    if (form) {
      setEditedData(form.form_data);
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const created = await intakeFormsApi.createIntakeForm(
        appointmentId,
        emptyFormData
      );

      setForm(created);
      setEditedData(created.form_data);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.detail
          : "Failed to start intake form."
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDraftFromAudio() {
    setIsProcessing(true);
    setError(null);
    try {
      const drafted = await intakeFormsApi.draftIntakeForm(appointmentId);
      setForm(drafted);
      setEditedData(drafted.form_data);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.detail
          : "AI-assisted drafting failed. Try manual entry instead."
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSave() {
    if (!form || !editedData) return;
    setIsProcessing(true);
    setError(null);
    try {
      const updated = await intakeFormsApi.updateIntakeForm(form.id, editedData);
      setForm(updated);
      setEditedData(updated.form_data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Save failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleFinalize() {
    if (!form) return;
    setIsProcessing(true);
    setError(null);
    try {
      const updated = await intakeFormsApi.finalizeIntakeForm(form.id);
      setForm(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Finalization failed.");
    } finally {
      setIsProcessing(false);
    }
  }

  const isNurse = user?.role === "nurse";

  function updateVital<K extends keyof VitalSigns>(key: K, value: string) {
    if (!editedData) return;
    const numValue = value === "" ? null : Number(value);
    setEditedData({ ...editedData, vitals: { ...editedData.vitals, [key]: numValue } });
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>6. Intake Form (Nurse)</span>
          <span className={`${styles.stageBadge} ${form?.is_final ? styles.stageComplete : styles.stagePending}`}>
            {form ? (form.is_final ? "Submitted" : "Draft") : "Not started"}
          </span>
        </div>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}>›</span>
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          {!isNurse && <p className={styles.pendingNote}>Only nurses can create or edit intake forms.</p>}

          {isNurse && !form && (
            <div className={styles.actionRow}>
              <button className={styles.primaryButton} disabled={isProcessing} onClick={handleStartManual}>
                Start manual entry
              </button>
              <button className={styles.secondaryButton} disabled={isProcessing} onClick={handleDraftFromAudio}>
                {isProcessing ? "Extracting..." : "Try AI-assisted extraction from audio"}
              </button>
            </div>
          )}

          {editedData && form && (
            <>
              {editedData.ai_generated && (
                <div className={styles.aiDisclosure}>
                  AI-extracted from a nurse-intake recording by {editedData.ai_model_name}. This extraction
                  is a raw, unparsed reading with quoted source sentences for verification -- review{" "}
                  {editedData.ai_raw_draft_text ? "the raw text below" : "carefully"} and enter confirmed
                  values into the fields manually.
                </div>
              )}
              {editedData.ai_raw_draft_text && (
                <pre
                  style={{
                    fontSize: "0.78rem",
                    background: "var(--color-bg)",
                    padding: "0.7rem",
                    borderRadius: "var(--radius-sm)",
                    whiteSpace: "pre-wrap",
                    marginBottom: "1rem",
                  }}
                >
                  {editedData.ai_raw_draft_text}
                </pre>
              )}
              {form.is_final && <div className={styles.finalBadge}>Submitted</div>}

              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label className={styles.label}>Blood Pressure Systolic</label>
                  <input
                    className={styles.input}
                    type="number"
                    disabled={form.is_final}
                    value={editedData.vitals.blood_pressure_systolic ?? ""}
                    onChange={(e) => updateVital("blood_pressure_systolic", e.target.value)}
                  />
                </div>
                <div className={styles.formField}>
                  <label className={styles.label}>Blood Pressure Diastolic</label>
                  <input
                    className={styles.input}
                    type="number"
                    disabled={form.is_final}
                    value={editedData.vitals.blood_pressure_diastolic ?? ""}
                    onChange={(e) => updateVital("blood_pressure_diastolic", e.target.value)}
                  />
                </div>
                <div className={styles.formField}>
                  <label className={styles.label}>Height (cm)</label>
                  <input
                    className={styles.input}
                    type="number"
                    disabled={form.is_final}
                    value={editedData.vitals.height_cm ?? ""}
                    onChange={(e) => updateVital("height_cm", e.target.value)}
                  />
                </div>
                <div className={styles.formField}>
                  <label className={styles.label}>Weight (kg)</label>
                  <input
                    className={styles.input}
                    type="number"
                    disabled={form.is_final}
                    value={editedData.vitals.weight_kg ?? ""}
                    onChange={(e) => updateVital("weight_kg", e.target.value)}
                  />
                </div>
                <div className={styles.formField}>
                  <label className={styles.label}>Temperature (°C)</label>
                  <input
                    className={styles.input}
                    type="number"
                    step="0.1"
                    disabled={form.is_final}
                    value={editedData.vitals.temperature_celsius ?? ""}
                    onChange={(e) => updateVital("temperature_celsius", e.target.value)}
                  />
                </div>
                <div className={styles.formField}>
                  <label className={styles.label}>Pulse (bpm)</label>
                  <input
                    className={styles.input}
                    type="number"
                    disabled={form.is_final}
                    value={editedData.vitals.pulse_bpm ?? ""}
                    onChange={(e) => updateVital("pulse_bpm", e.target.value)}
                  />
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label className={styles.label}>Reason for Visit</label>
                  <input
                    className={styles.input}
                    disabled={form.is_final}
                    value={editedData.reason_for_visit ?? ""}
                    onChange={(e) => setEditedData({ ...editedData, reason_for_visit: e.target.value || null })}
                  />
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label className={styles.label}>Known Allergies</label>
                  <input
                    className={styles.input}
                    disabled={form.is_final}
                    value={editedData.known_allergies ?? ""}
                    onChange={(e) => setEditedData({ ...editedData, known_allergies: e.target.value || null })}
                  />
                </div>
              </div>

              {!form.is_final && isNurse && (
                <div className={styles.actionRow}>
                  <button className={styles.secondaryButton} disabled={isProcessing} onClick={handleSave}>
                    Save changes
                  </button>
                  <button className={styles.primaryButton} disabled={isProcessing} onClick={handleFinalize}>
                    Submit intake form
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}