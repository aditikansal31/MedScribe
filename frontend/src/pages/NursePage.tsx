import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AppShell } from "../components/AppShell";
import * as appointmentApi from "../api/appointments";
import * as patientApi from "../api/patients";

import type { Appointment } from "../types/appointment";
import type { Patient } from "../types/patient";

import styles from "./NursePage.module.css";

function formatDate(value: string | null): string {
  if (!value) return "—";

  return new Date(value).toLocaleString();
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function NursePage() {
  const navigate = useNavigate();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);

  const [search, setSearch] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [chiefComplaint, setChiefComplaint] = useState("");

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [appointmentData, patientData] = await Promise.all([
        appointmentApi.listAppointments(),
        patientApi.listPatients(search || undefined),
      ]);

      setAppointments(appointmentData);
      setPatients(patientData);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load nurse dashboard."
      );
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleCreateAppointment() {
    if (!selectedPatientId) {
      setError("Select a patient before creating an appointment.");
      return;
    }

    setCreating(true);
    setError("");

    try {
      const appointment = await appointmentApi.createAppointment({
        patient_id: selectedPatientId,
        chief_complaint: chiefComplaint.trim() || undefined,
      });

      navigate(`/nurse/appointments/${appointment.id}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to create appointment."
      );
    } finally {
      setCreating(false);
    }
  }

  const openAppointments = appointments.filter(
    (appointment) => appointment.status !== "complete"
  );

  const completedAppointments = appointments.filter(
    (appointment) => appointment.status === "complete"
  );

  return (
    <AppShell>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>
              Nurse workspace
            </div>

            <h1 className={styles.title}>
              Patient Intake
            </h1>

            <p className={styles.subtitle}>
              Create and manage patient intake sessions.
            </p>
          </div>

          <Link
            to="/nurse/patients"
            className={styles.secondaryButton}
          >
            Patient Registry
          </Link>
        </header>

        {error && (
          <div className={styles.errorBanner}>
            {error}
          </div>
        )}

        <section className={styles.statsGrid}>
          <div className={styles.statCard}>
            <span>Open appointments</span>
            <strong>{openAppointments.length}</strong>
          </div>

          <div className={styles.statCard}>
            <span>Completed</span>
            <strong>{completedAppointments.length}</strong>
          </div>

          <div className={styles.statCard}>
            <span>Total appointments</span>
            <strong>{appointments.length}</strong>
          </div>
        </section>

        <section className={styles.contentGrid}>
          <div>
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2>New intake</h2>
                  <p>
                    Start a new appointment for a patient.
                  </p>
                </div>
              </div>

              <div className={styles.form}>
                <label>
                  <span>Search patient</span>

                  <input
                    value={search}
                    onChange={(event) =>
                      setSearch(event.target.value)
                    }
                    placeholder="Name or MRN"
                  />
                </label>

                <label>
                  <span>Patient</span>

                  <select
                    value={selectedPatientId}
                    onChange={(event) =>
                      setSelectedPatientId(event.target.value)
                    }
                  >
                    <option value="">
                      Select patient
                    </option>

                    {patients.map((patient) => (
                      <option
                        key={patient.id}
                        value={patient.id}
                      >
                        {patient.full_name} — {patient.mrn}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>
                    Reason for visit
                    <small> Optional</small>
                  </span>

                  <textarea
                    value={chiefComplaint}
                    onChange={(event) =>
                      setChiefComplaint(event.target.value)
                    }
                    placeholder="Patient's stated reason for visit"
                    rows={4}
                  />
                </label>

                <button
                  className={styles.primaryButton}
                  disabled={creating || loading}
                  onClick={() => void handleCreateAppointment()}
                >
                  {creating
                    ? "Creating..."
                    : "Create Intake Session"}
                </button>
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2>Appointments</h2>
                  <p>
                    Continue an existing patient intake.
                  </p>
                </div>

                <button
                  className={styles.secondaryButton}
                  onClick={() => void loadData()}
                >
                  Refresh
                </button>
              </div>

              {loading ? (
                <div className={styles.emptyState}>
                  Loading appointments...
                </div>
              ) : appointments.length === 0 ? (
                <div className={styles.emptyState}>
                  No appointments found.
                </div>
              ) : (
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Patient</th>
                        <th>Status</th>
                        <th>Reason</th>
                        <th>Created</th>
                        <th />
                      </tr>
                    </thead>

                    <tbody>
                      {appointments.map((appointment) => {
                        const patient = patients.find(
                          (item) =>
                            item.id === appointment.patient_id
                        );

                        return (
                          <tr key={appointment.id}>
                            <td>
                              <div className={styles.patientName}>
                                {patient?.full_name ??
                                  appointment.patient_id}
                              </div>

                              {patient && (
                                <div className={styles.muted}>
                                  {patient.mrn}
                                </div>
                              )}
                            </td>

                            <td>
                              <span className={styles.statusPill}>
                                {statusLabel(
                                  appointment.status
                                )}
                              </span>
                            </td>

                            <td>
                              {appointment.chief_complaint || "—"}
                            </td>

                            <td>
                              {formatDate(
                                appointment.created_at
                              )}
                            </td>

                            <td>
                              <Link
                                className={styles.openLink}
                                to={`/nurse/appointments/${appointment.id}`}
                              >
                                Open
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <aside>
            <section className={styles.card}>
              <h2>Quick actions</h2>

              <div className={styles.quickActions}>
                <Link to="/nurse/patients">
                  View patients
                </Link>

                <Link to="/nurse">
                  Refresh dashboard
                </Link>
              </div>
            </section>

            <section className={styles.card}>
              <h2>Workflow</h2>

              <ol className={styles.workflow}>
                <li>Create appointment</li>
                <li>Enter or record intake data</li>
                <li>Process audio when applicable</li>
                <li>Review extracted information</li>
                <li>Finalize intake</li>
              </ol>
            </section>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}