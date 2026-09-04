// Runs before the stylesheet paints: apply a stored light/dark choice so the page does not flash.
(() => { try { const t = localStorage.getItem("status.theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (_) { /* storage blocked */ } })();
