/** Opens a web link outside the app: the system browser on desktop and
 *  Android, a new tab on the web. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const w = window as unknown as {
    runtime?: { BrowserOpenURL?: (u: string) => void };
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  if (w.runtime?.BrowserOpenURL) w.runtime.BrowserOpenURL(url); // Wails
  else if (w.Capacitor?.isNativePlatform?.()) window.location.assign(url); // Capacitor hands other hosts to the browser
  else window.open(url, "_blank", "noopener,noreferrer");
}
