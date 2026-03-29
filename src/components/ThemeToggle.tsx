import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

type ThemeMode = "light" | "dark" | "auto";

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const stored = window.localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

function applyThemeMode(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);
  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
  document.documentElement.style.colorScheme = resolved;
}

const icons = { light: Sun, dark: Moon, auto: Monitor } as const;

export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("auto");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const m = getInitialMode();
    setMode(m);
    applyThemeMode(m);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("auto");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  function toggleMode() {
    const next: ThemeMode = mode === "light" ? "dark" : mode === "dark" ? "auto" : "light";
    setMode(next);
    applyThemeMode(next);
    window.localStorage.setItem("theme", next);
  }

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={`Theme: ${mode}. Click to cycle.`}
      title={`Theme: ${mode}`}
      className="relative flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-(--chip-bg) hover:text-(--sea-ink)"
    >
      <div className="relative h-3.75 w-3.75">
        {(Object.keys(icons) as ThemeMode[]).map((m) => {
          const Icon = icons[m];
          const active = mounted && mode === m;
          return (
            <span
              key={m}
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center transition-all duration-300"
              style={{
                opacity: active ? 1 : 0,
                transform: active ? "scale(1) rotate(0deg)" : "scale(0.4) rotate(90deg)",
              }}
            >
              <Icon size={15} strokeWidth={1.75} />
            </span>
          );
        })}
      </div>
    </button>
  );
}
