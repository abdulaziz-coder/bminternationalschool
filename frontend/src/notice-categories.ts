/** Categories offered before an admin has created any; their names are translated on display. */
export const defaultCategories = ['News', 'Admission guide'];

/** Distinct category names in first-seen order. */
export function distinctCategories(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * A stable colour slot (0–4) for a category badge: the two defaults keep their own colours,
 * and every admin-created category always lands on the same one of the remaining three.
 */
export function categoryTone(name: string): number {
  const fixed = defaultCategories.indexOf(name);
  if (fixed >= 0) return fixed;
  let hash = 0;
  for (const character of name.toLowerCase()) hash = (hash * 31 + character.codePointAt(0)!) % 997;
  return 2 + hash % 3;
}
