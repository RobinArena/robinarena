export type ArenaTheme = "dark" | "light";

const THEME_STORAGE_KEY = "model-market-theme";
const THEME_COLORS: Record<ArenaTheme, string> = {
  dark: "#0a0c0a",
  light: "#f3f4ed",
};

function validTheme(value: unknown): value is ArenaTheme {
  return value === "dark" || value === "light";
}

export function useArenaTheme() {
  const theme = useState<ArenaTheme>("arena-theme", () => "dark");

  function applyTheme(nextTheme: ArenaTheme, persist = true) {
    theme.value = nextTheme;
    if (!import.meta.client) return;

    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLORS[nextTheme]);
    if (persist) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        // The selected theme still applies for the current page.
      }
    }
  }

  function toggleTheme() {
    applyTheme(theme.value === "dark" ? "light" : "dark");
  }

  function syncStoredTheme(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme(validTheme(event.newValue) ? event.newValue : "dark", false);
  }

  onMounted(() => {
    let initialTheme: unknown = document.documentElement.dataset.theme;
    try {
      const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      if (validTheme(storedTheme)) initialTheme = storedTheme;
    } catch {
      // The pre-paint document theme remains the current selection.
    }
    applyTheme(validTheme(initialTheme) ? initialTheme : "dark", false);
    window.addEventListener("storage", syncStoredTheme);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("storage", syncStoredTheme);
  });

  return {
    theme: readonly(theme),
    toggleTheme,
  };
}
