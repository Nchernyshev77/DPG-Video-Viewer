// Dynamic import also catches missing dependencies and unavailable WebGL at startup.
export let app = null;
try {
  const { createApp } = await import("./app.js");
  app = createApp();
} catch (error) {
  console.error("Viewer startup failed", error);
  const status = document.getElementById("status");
  status?.classList.add("show");
  status?.removeAttribute("role");
  const text = document.getElementById("statusText");
  if (text)
    text.textContent =
      "The viewer could not start. Check WebGL support and open the project through an HTTP server.";
}
