import { useEffect, useState } from "react";
import { api, type AvailabilityAll, type CandidateDate, type BlockedDate, type Session, type Stats } from "../api";

export function useSchedulingData(campaignId: string) {
  const [availability, setAvailability] = useState<AvailabilityAll | null>(null);
  const [candidates, setCandidates] = useState<CandidateDate[]>([]);
  const [blocked, setBlocked] = useState<BlockedDate[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const [avail, cand, sess, st] = await Promise.all([
        api.getAllAvailability(campaignId),
        api.getCandidates(campaignId),
        api.getSessions(campaignId),
        api.getStats(campaignId),
      ]);
      setAvailability(avail);
      setCandidates(cand.candidates);
      setBlocked(cand.blocked);
      setSessions(sess.sessions);
      setStats(st);
    } catch {
      setError("Couldn't load scheduling data.");
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  return { availability, candidates, blocked, sessions, stats, error, reload };
}
