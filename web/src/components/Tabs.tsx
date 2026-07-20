import { useState, type ReactNode } from "react";

export function Tabs({ tabs, defaultTab }: { tabs: Array<{ id: string; label: string; content: ReactNode }>; defaultTab?: string }) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);

  return (
    <div>
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--pp-line)",
          marginBottom: 20,
          overflowX: "auto",
        }}
      >
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(t.id)}
              style={{
                border: "none",
                background: "none",
                padding: "10px 14px",
                fontSize: 13.5,
                fontWeight: 600,
                color: isActive ? "var(--pp-ink)" : "var(--pp-ink-soft)",
                borderBottom: isActive ? "2px solid var(--pp-brass)" : "2px solid transparent",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={t.id !== active}>
          {t.id === active && t.content}
        </div>
      ))}
    </div>
  );
}
