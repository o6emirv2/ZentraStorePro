import { recoveryDestination } from "./routes.mjs?v=113";
import { installDevicePolicy } from "./device.mjs?v=113";
import "./ambient.mjs?v=113";

installDevicePolicy(document, window);
if (document.body.dataset.recovery === "missing") {
  const target = recoveryDestination(window.location.href);
  if (target) window.location.replace(target);
}
document.querySelector("[data-retry]")?.addEventListener("click", (event) => {
  event.preventDefault();
  window.location.reload();
});
