import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Campaign } from "../api";
import { WeeklyDefaultsEditor } from "../components/WeeklyDefaults";
import { Logo } from "../components/Logo";

export function CampaignWelcome() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    api
      .getCampaign(campaignId)
      .then(({ campaign }) => setCampaign(campaign))
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 403 ? "You're not part of this campaign." : "Campaign not found.")
      );
  }, [campaignId]);

  if (error) {
    return (
      <div className="pp-empty">
        <p>{error}</p>
        <Link to="/" className="pp-btn pp-btn-ghost" style={{ marginTop: 16 }}>
          Back to campaigns
        </Link>
      </div>
    );
  }

  if (!campaign || !campaignId) return <p>Loading…</p>;

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 520, margin: "0 auto" }}>
      <div style={{ textAlign: "center", paddingTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <Logo size={34} />
        </div>
        <h1 style={{ fontSize: 24 }}>Welcome to {campaign.name}.</h1>
        <p style={{ marginTop: 8, maxWidth: 400, marginLeft: "auto", marginRight: "auto" }}>
          Before you dive in, set which days of the week usually work for you. You can always fine-tune specific
          dates later on the campaign calendar — this is just your starting pattern.
        </p>
      </div>

      <WeeklyDefaultsEditor campaignId={campaignId} onSaved={() => {}} />

      <button className="pp-btn pp-btn-brass" style={{ justifySelf: "center" }} onClick={() => navigate(`/campaigns/${campaignId}`)}>
        Continue to {campaign.name}
      </button>
    </div>
  );
}
