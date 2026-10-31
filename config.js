// Einstellungen der Scanner-App. Hier steht nichts Geheimes.
// DROPBOX_APP_KEY: der öffentliche "App key" aus der Dropbox App Console (kein Secret!).
// Leer lassen geht auch: dann fragt die App beim Verbinden danach und merkt ihn sich auf dem Handy.
export const CONFIG = {
  DROPBOX_APP_KEY: 'fb5lq032woye6k8',
  // Zielordner in Felix' Dropbox. Die Routine "Posteingang sortieren" holt hier ab.
  FOLDER: '/Posteingang',
  // Rücksprung-Adresse nach dem Dropbox-Login. Leer = automatisch die Adresse der App
  // (z.B. https://felixfueller.github.io/fmrs24-scanner/). Muss in der App Console eingetragen sein.
  REDIRECT_URI: '',
  // Durchläufe der Routine (Uhrzeit Deutschland)
  RUNS: ['07:31', '11:31', '17:31'],
  // PDF: Zielauflösung und Obergrenze je Dokument
  DPI: 200,
  MAX_DOC_BYTES: 3 * 1024 * 1024,
};
