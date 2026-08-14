export function networkHandle(displayName: string): string {
  const normalized = displayName
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 24);

  return normalized || 'unclaimed';
}

export function identityHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value.normalize('NFKC')) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function networkShortId(displayName: string): string {
  if (!displayName.trim()) return '------';
  return identityHash(displayName).toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

export function identitySignal(displayName: string, size = 24): boolean[] {
  const hash = identityHash(displayName || 'agent-pool');
  return Array.from({ length: size }, (_, index) => {
    const rotated = (hash >>> (index % 24)) ^ Math.imul(index + 3, 0x45d9f3b);
    return (rotated & 3) !== 0;
  });
}
