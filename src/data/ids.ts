/** Time-ordered, collision-resistant id (no crypto dependency needed for local records). */
export function newId(): string {
  const rand = Math.floor(Math.random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `${Date.now().toString(36)}-${rand}`;
}
