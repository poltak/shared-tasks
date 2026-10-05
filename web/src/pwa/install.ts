/** True when the app runs as an installed app, not in a browser tab. */
export function isStandalone(): boolean {
  // Safari on iOS also has its own property for this.
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** True on an iPhone or an iPad. There, notifications work only in the installed app. */
export function isIos(): boolean {
  const agent = navigator.userAgent;
  // An iPad says that it is a Mac. A Mac has no touch screen.
  return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
}
