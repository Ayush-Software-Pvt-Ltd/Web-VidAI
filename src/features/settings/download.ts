/** Saving and reading files in the page (no native dialogs): a download made from text, a file read as text. */

/** Starts a browser download of `text` as a file called `fileName`. */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken the file when the click returns; a moment later the address can go.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** The text of a file the person chose. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(new Error("The file could not be read."));
    };
    reader.readAsText(file);
  });
}

/** `2026-11-22` for a date, in the person's own time zone. */
export function localDateStamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
