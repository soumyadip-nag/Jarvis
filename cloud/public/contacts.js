// Finds the closest contact to a spoken name. Runs only on the phone: contacts are never uploaded.
(() => {
  const clean = (text) => String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return 1 - row[b.length] / Math.max(a.length, b.length);
  }

  function score(query, name) {
    const q = clean(query).replace(/^(my|the) /, "");
    const n = clean(name);
    if (!q || !n) return 0;
    if (q === n) return 1;
    const nameWords = n.split(" ");
    const perWord = q.split(" ").map((word) => Math.max(...nameWords.map((part) => {
      if (part === word) return 1;
      if (word.length >= 2 && part.startsWith(word)) return 0.85;
      return similarity(word, part);
    })));
    const average = perWord.reduce((sum, value) => sum + value, 0) / perWord.length;
    return Math.max(similarity(q, n), average * 0.95);
  }

  /** Closest contacts first: [{ name, tel, score }]. */
  function rank(query, contacts, limit = 3) {
    return (contacts || [])
      .map((c) => ({ ...c, score: score(query, c.name) }))
      .filter((c) => c.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** The one match to dial without asking, or null if there is none or it is too close to call. */
  function bestMatch(matches) {
    const [first, second] = matches;
    if (!first || first.score < 0.75) return null;
    return !second || first.score - second.score >= 0.1 ? first : null;
  }

  globalThis.JarvisContacts = { rank, bestMatch, score };
})();
