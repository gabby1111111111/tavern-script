import {
  beginRegionEditorSession,
  canConfirmRegionRedraw,
  includeRegionPoint,
  normalizeRegionBounds,
  resolveRegionEditorDocument,
  resolveRegionEditorMountTarget,
} from '../src/杠杠の生图机/region-redraw-editor';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bounds = includeRegionPoint(includeRegionPoint(null, 20, 30, 10), 90, 70, 5);
const region = normalizeRegionBounds(bounds, 100, 100);
assert(region !== null, 'non-empty strokes should produce a region');
assert(region.x === 0.1 && region.y === 0.2, 'region origin should be normalized');
assert(region.width === 0.85 && region.height === 0.55, 'region size should include brush radius');
assert(normalizeRegionBounds(null, 100, 100) === null, 'empty strokes must not produce a region');
assert(!canConfirmRegionRedraw('prompt', null), 'empty selection must block confirmation');
assert(!canConfirmRegionRedraw('   ', bounds), 'blank one-shot prompt must block confirmation');
assert(canConfirmRegionRedraw('replace the flower', bounds), 'selection and prompt should allow confirmation');

const clipped = normalizeRegionBounds(includeRegionPoint(null, 0, 0, 20), 100, 50);
assert(clipped?.x === 0 && clipped.y === 0, 'brush bounds should be clipped to the image');
assert(clipped?.width === 0.2 && clipped.height === 0.4, 'clipped bounds should remain normalized');

const iframeDocument = { name: 'iframe' } as unknown as Document;
const hostBody = { ownerDocument: null } as unknown as HTMLElement;
const hostDocument = { name: 'host', body: hostBody } as unknown as Document;
(hostBody as unknown as { ownerDocument: Document }).ownerDocument = hostDocument;
const globalWithDollar = globalThis as unknown as { $?: typeof $ };
const previousDollar = globalWithDollar.$;
globalWithDollar.$ = (() => [{ ownerDocument: hostDocument }]) as unknown as typeof $;
assert(resolveRegionEditorDocument(iframeDocument) === hostDocument, 'editor should select the Tavern host document');
assert(resolveRegionEditorMountTarget(iframeDocument) === hostBody, 'editor should mount into the Tavern host body');
globalWithDollar.$ = (() => []) as unknown as typeof $;
assert(resolveRegionEditorDocument(iframeDocument) === iframeDocument, 'editor should retain a safe fallback document');
if (previousDollar) globalWithDollar.$ = previousDollar;
else delete globalWithDollar.$;

async function testEditorLifecycle(): Promise<void> {
  const external = new AbortController();
  let overlayPresent = true;
  let resolveFirst: (value: null) => void = () => undefined;
  const firstResult = new Promise<null>(resolve => {
    resolveFirst = resolve;
  });
  let endFirst = (): void => undefined;
  const closeFirst = (): void => {
    overlayPresent = false;
    endFirst();
    resolveFirst(null);
  };
  endFirst = beginRegionEditorSession(external.signal, closeFirst);
  external.abort();
  assert((await firstResult) === null && !overlayPresent, 'external abort should close the overlay and settle null');

  let firstOpen = true;
  let resolveOld: (value: null) => void = () => undefined;
  const oldResult = new Promise<null>(resolve => {
    resolveOld = resolve;
  });
  let endOld = (): void => undefined;
  const closeOld = (): void => {
    firstOpen = false;
    endOld();
    resolveOld(null);
  };
  endOld = beginRegionEditorSession(undefined, closeOld);
  let secondOpen = true;
  const endSecond = beginRegionEditorSession(undefined, () => {
    secondOpen = false;
  });
  assert((await oldResult) === null && !firstOpen && secondOpen, 'opening a second editor should settle only the old one');
  endSecond();
}

void testEditorLifecycle().then(() => console.log('story image region redraw editor tests passed'));
