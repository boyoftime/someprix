/** A transfer rate: "450 KB/s", "1.2 MB/s". */
export function formatSpeed(bytesPerSecond: number) {
  return `${formatSize(Math.round(bytesPerSecond))}/s`;
}

/** Time remaining, rounded the way people say it: "8 s left", "3 min left". */
export function formatTimeLeft(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min left` : `${Math.round(minutes / 60)} h left`;
}

/** A byte count for people: "512 B", "3.4 KB", "12 MB". */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
