import { Link } from "react-router-dom";
import { RoleBadge } from "./RoleBadge";
import type { Campaign } from "../api";

const CADENCE_LABEL: Record<Campaign["cadence_type"], string> = {
  "bi-weekly": "Every 2 weeks",
  custom_interval: "Custom interval",
  weekly_static: "Weekly",
};

export function CampaignCard({ campaign }: { campaign: Campaign }) {
  return (
    <Link
      to={`/campaigns/${campaign.id}`}
      className="pp-card"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "18px 20px",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div>
        <h3 style={{ fontSize: 16 }}>{campaign.name}</h3>
        <p className="pp-mono" style={{ fontSize: 12.5, marginTop: 4 }}>
          {CADENCE_LABEL[campaign.cadence_type]} · anchored {campaign.start_date}
        </p>
      </div>
      {campaign.myRole && <RoleBadge role={campaign.myRole} />}
    </Link>
  );
}
