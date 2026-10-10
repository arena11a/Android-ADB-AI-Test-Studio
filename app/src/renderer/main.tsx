import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useStudio } from "./store";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

function Root() {
  const init = useStudio((s) => s.init);

  // theme follows the OS; a .dark class on <html> switches every UI colour
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    const off = init();
    const q = new URLSearchParams(location.hash.replace(/^#/, ""));
    const start = q.get("page");
    if (start) useStudio.getState().setPage(start as ReturnType<typeof useStudio.getState>["page"]);
    if (q.get("firstrun") === "0") localStorage.setItem("adbstudio.firstRunSeen", "1");
    const lang = q.get("lang");
    if (lang === "th" || lang === "en") localStorage.setItem("adbstudio.lang", lang);
    return () => { mq.removeEventListener("change", apply); off(); };
  }, [init]);

  return <App />;
}

createRoot(el).render(<Root />);
