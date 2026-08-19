/**
 * Native HTML5 drag-and-drop for a flat list of sibling elements. No library —
 * courses, lessons and lesson blocks all reorder the same way, so this is the
 * one place that logic lives.
 *
 * Each item must carry the handle element passed as `handleSelector` (usually
 * a `.drag-handle` icon) — the whole row stays clickable (links, buttons)
 * because only the handle is what starts the drag.
 */
export function makeSortable(container, itemSelector, handleSelector, onReorder) {
  let dragging = null;

  for (const item of container.querySelectorAll(itemSelector)) {
    const handle = item.querySelector(handleSelector);
    if (!handle) continue;

    item.draggable = true;
    handle.classList.add("drag-handle");

    // Only a drag started from the handle should count — otherwise dragging
    // starts from clicking a link or button inside the row.
    item.addEventListener("dragstart", (event) => {
      if (!event.composedPath().includes(handle)) {
        event.preventDefault();
        return;
      }
      dragging = item;
      item.classList.add("sortable-drag");
      event.dataTransfer.effectAllowed = "move";
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("sortable-drag");
      container.querySelectorAll(".sortable-ghost").forEach((n) => n.classList.remove("sortable-ghost"));
      dragging = null;
    });

    item.addEventListener("dragover", (event) => {
      if (!dragging || dragging === item) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";

      const rect = item.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      container.querySelectorAll(".sortable-ghost").forEach((n) => n.classList.remove("sortable-ghost"));
      item.classList.add("sortable-ghost");
      item.classList.toggle("sortable-ghost--before", before);
      item.classList.toggle("sortable-ghost--after", !before);
    });

    item.addEventListener("drop", (event) => {
      if (!dragging || dragging === item) return;
      event.preventDefault();

      const rect = item.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      item.insertAdjacentElement(before ? "beforebegin" : "afterend", dragging);

      const orderedIds = [...container.querySelectorAll(itemSelector)]
        .map((node) => node.dataset.sortId)
        .filter(Boolean);
      onReorder(orderedIds);
    });
  }
}
