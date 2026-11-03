/**
 * `items` as a dropdown or a combobox lists them (AR14): those in no group, then each group with its
 * own, by the key `sectionOf` gives them, in the order of their first item. A group holds at least
 * one item, so that no heading is shown without any.
 */
export function sectioned<Item>(
  items: readonly Item[],
  sectionOf: (item: Item) => string | undefined,
): { unsectioned: readonly Item[]; sections: [string, Item[]][] } {
  // Most lists have no groups, among them lists of thousands of suggestions (AR9), which are then
  // shown as they are.
  if (!items.some((item) => sectionOf(item) !== undefined)) {
    return { unsectioned: items, sections: [] }
  }
  const unsectioned: Item[] = []
  const sections = new Map<string, Item[]>()
  for (const item of items) {
    const section = sectionOf(item)
    if (section === undefined) unsectioned.push(item)
    else if (sections.has(section)) sections.get(section)!.push(item)
    else sections.set(section, [item])
  }
  return { unsectioned, sections: [...sections] }
}
