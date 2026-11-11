const pendingRoots = new Set();
let scanTimer;
function flushPostRoots() {
  scanTimer = undefined;
  const roots = new Set([...pendingRoots].filter(root => root.isConnected));
  pendingRoots.clear();
  for (const root of roots) {
    let parent = root.parentElement;
    while (parent && !roots.has(parent)) parent = parent.parentElement;
    if (!parent) s(root);
  }
}
const o = {childList: true, subtree: true, attributes: true,
  attributeFilter: ["class", "href", "src", "srcset"]};
const a = new MutationObserver(records => {
  for (const record of records) {
    const root = record.type === "attributes" ? record.target.parentElement : record.target;
    if (root?.querySelectorAll) pendingRoots.add(root);
  }
  if (pendingRoots.size && scanTimer === undefined) scanTimer = setTimeout(flushPostRoots, 50);
});
