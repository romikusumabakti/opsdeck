// A PDF worker that never answers: stands in for pdf.js stuck on a hostile
// file (file-text.ts must terminate it at its timeout).
declare const self: Worker;
self.onmessage = () => {
  setInterval(() => {}, 1000);
};

export {};
