// Extensions.triggerAction requires the browser's tab target, not its child
// page target. Target.getTargets excludes tabs unless an explicit filter is
// supplied. Follow TargetInfo.parentId where available; never guess among
// multiple matching tabs.
export function tabTargetForPage(pageInfo,targetInfos) {
  const byId=new Map(targetInfos.map(info=>[info.targetId,info]));
  let candidate=pageInfo;
  const visited=new Set();
  while (candidate && !visited.has(candidate.targetId)) {
    visited.add(candidate.targetId);
    if (candidate.type==='tab') return candidate;
    candidate=candidate.parentId ? byId.get(candidate.parentId) : null;
  }
  const matches=targetInfos.filter(info=>info.type==='tab' && info.url===pageInfo.url &&
    (!pageInfo.browserContextId || info.browserContextId===pageInfo.browserContextId));
  if (matches.length!==1) throw new Error('Could not unambiguously resolve the source page to its Chromium tab target.');
  return matches[0];
}
