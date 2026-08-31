import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import * as appointmentsApi from "../api/appointments";
import type { Appointment } from "../types/appointment";
import { ApiError } from "../api/client";
import styles from "./PatientsPage.module.css"; // reusing Phase 6's table styling, same visual language

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AppointmentsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await appointmentsApi.listAppointments();
      setAppointments(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to load appointments.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAppointment(id: string) {
    const rolePath = user?.role === "doctor" ? "doctor" : "nurse";
    navigate(`/${rolePath}/appointments/${id}`);
  }

  return (
    <AppShell>
      <h1>Appointments</h1>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.card}>
        {isLoading ? (
          <div className={styles.loadingState}>Loading appointments...</div>
        ) : appointments.length === 0 ? (
          <div className={styles.emptyState}>No appointments yet. Create one from the Patients page.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Chief Complaint</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((a) => (
                <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => openAppointment(a.id)}>
                  <td>{a.status.replace(/_/g, " ")}</td>
                  <td>{a.chief_complaint || "—"}</td>
                  <td>{formatDateTime(a.created_at)}</td>
                  <td>
                    <span style={{ color: "var(--color-primary)", fontSize: "0.82rem" }}>Open →</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}