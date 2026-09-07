export type RegionRedrawSelection = {
  prompt: string;
  markedImage: string;
  region: { x: number; y: number; width: number; height: number };
};

export type RegionBounds = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

export function includeRegionPoint(bounds: RegionBounds | null, x: number, y: number, radius: number): RegionBounds {
  const next = {
    minX: x - radius,
    minY: y - radius,
    maxX: x + radius,
    maxY: y + radius,
  };
  if (!bounds) return next;
  return {
    minX: Math.min(bounds.minX, next.minX),
    minY: Math.min(bounds.minY, next.minY),
    maxX: Math.max(bounds.maxX, next.maxX),
    maxY: Math.max(bounds.maxY, next.maxY),
  };
}

export function normalizeRegionBounds(
  bounds: RegionBounds | null,
  imageWidth: number,
  imageHeight: number,
): RegionRedrawSelection['region'] | null {
  if (!bounds || imageWidth <= 0 || imageHeight <= 0) return null;
  const left = Math.max(0, Math.min(imageWidth, bounds.minX));
  const top = Math.max(0, Math.min(imageHeight, bounds.minY));
  const right = Math.max(left, Math.min(imageWidth, bounds.maxX));
  const bottom = Math.max(top, Math.min(imageHeight, bounds.maxY));
  if (right <= left || bottom <= top) return null;
  return {
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight,
  };
}

export function canConfirmRegionRedraw(prompt: string, bounds: RegionBounds | null): boolean {
  return prompt.trim().length > 0 && bounds !== null;
}

type Stroke = Readonly<{ points: ReadonlyArray<Readonly<{ x: number; y: number }>>; radius: number }>;
let activeRegionEditorClose: (() => void) | null = null;

export function beginRegionEditorSession(signal: AbortSignal | undefined, close: () => void): () => void {
  activeRegionEditorClose?.();
  activeRegionEditorClose = close;
  const onAbort = (): void => close();
  signal?.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal?.removeEventListener('abort', onAbort);
    if (activeRegionEditorClose === close) activeRegionEditorClose = null;
  };
}

export function resolveRegionEditorDocument(fallbackDocument: Document): Document {
  const hostBody = typeof $ === 'function' ? $('body')[0] : undefined;
  return hostBody?.ownerDocument ?? fallbackDocument;
}

export function resolveRegionEditorMountTarget(fallbackDocument: Document): HTMLElement {
  return resolveRegionEditorDocument(fallbackDocument).body;
}

function element<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = ownerDocument.createElement(tag);
  value.className = className;
  if (text) value.textContent = text;
  return value;
}

function loadEditorImage(imageUrl: string): Promise<{ image: HTMLImageElement; revoke?: () => void }> {
  const load = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('原图加载失败'));
      image.src = url;
    });

  if (/^(?:blob:|data:)/i.test(imageUrl)) return load(imageUrl).then(image => ({ image }));
  return fetch(imageUrl)
    .then(response => {
      if (!response.ok) throw new Error('原图加载失败');
      return response.blob();
    })
    .then(blob => {
      const objectUrl = URL.createObjectURL(blob);
      return load(objectUrl)
        .then(image => ({ image, revoke: () => URL.revokeObjectURL(objectUrl) }))
        .catch(error => {
          URL.revokeObjectURL(objectUrl);
          throw error;
        });
    })
    .catch(() => load(imageUrl).then(image => ({ image })));
}

export async function openRegionRedrawEditor(input: {
  imageUrl: string;
  signal?: AbortSignal;
}): Promise<RegionRedrawSelection | null> {
  if (input.signal?.aborted) return null;
  return await new Promise<RegionRedrawSelection | null>(resolve => {
    const mountTarget = resolveRegionEditorMountTarget(document);
    const hostDocument = mountTarget.ownerDocument;
    const abortController = new AbortController();
    const { signal } = abortController;
    const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) =>
      element(hostDocument, tag, className, text);
    const overlay = create('div', 'story-image-region-editor');
    const dialog = create('div', 'story-image-region-editor__dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'story-image-region-editor-title');
    const title = create('h3', 'story-image-region-editor__title', '区域重绘');
    title.id = 'story-image-region-editor-title';
    const hint = create('p', 'story-image-region-editor__hint', '在原图上涂抹需要修改的区域。');
    const stage = create('div', 'story-image-region-editor__stage');
    const canvas = create('canvas', 'story-image-region-editor__canvas');
    canvas.setAttribute('aria-label', '区域选择画布');
    canvas.tabIndex = 0;
    stage.append(canvas);
    const controls = create('div', 'story-image-region-editor__controls');
    const brushLabel = create('label', 'story-image-region-editor__brush-label', '笔刷大小');
    const brush = create('input', 'story-image-region-editor__brush');
    brush.type = 'range';
    brush.min = '4';
    brush.max = '120';
    brush.value = '32';
    brushLabel.append(brush);
    const undo = create('button', 'story-image-region-editor__button', '撤销');
    undo.type = 'button';
    undo.disabled = true;
    const clear = create('button', 'story-image-region-editor__button', '清空');
    clear.type = 'button';
    clear.disabled = true;
    controls.append(brushLabel, undo, clear);
    const promptLabel = create('label', 'story-image-region-editor__prompt-label', '这个区域要改成什么？');
    const prompt = create('textarea', 'story-image-region-editor__prompt');
    prompt.rows = 3;
    prompt.autocomplete = 'off';
    prompt.placeholder = '例如：把手里的花换成红色玫瑰';
    promptLabel.append(prompt);
    const error = create('p', 'story-image-region-editor__error');
    error.setAttribute('role', 'alert');
    const actions = create('div', 'story-image-region-editor__footer');
    const cancel = create('button', 'story-image-region-editor__button', '取消');
    cancel.type = 'button';
    const confirm = create('button', 'story-image-region-editor__button story-image-region-editor__button--primary', '确认重绘');
    confirm.type = 'button';
    confirm.disabled = true;
    actions.append(cancel, confirm);
    dialog.append(title, hint, stage, controls, promptLabel, error, actions);
    overlay.append(dialog);
    mountTarget.append(overlay);

    let loaded: { image: HTMLImageElement; revoke?: () => void } | null = null;
    let strokes: Stroke[] = [];
    let activePoints: Array<{ x: number; y: number }> | null = null;
    let activePointerId: number | null = null;
    let settled = false;
    let endSession = (): void => undefined;

    const bounds = (): RegionBounds | null =>
      strokes.reduce<RegionBounds | null>(
        (current, stroke) =>
          stroke.points.reduce(
            (strokeBounds, point) => includeRegionPoint(strokeBounds, point.x, point.y, stroke.radius),
            current,
          ),
        null,
      );
    const updateConfirm = (): void => {
      confirm.disabled = !loaded || !canConfirmRegionRedraw(prompt.value, bounds());
    };
    const draw = (): void => {
      if (!loaded) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(loaded.image, 0, 0, canvas.width, canvas.height);
      context.strokeStyle = 'rgba(255, 0, 170, 0.55)';
      context.fillStyle = 'rgba(255, 0, 170, 0.55)';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      strokes.forEach(stroke => {
        const [first, ...rest] = stroke.points;
        if (!first) return;
        context.lineWidth = stroke.radius * 2;
        context.beginPath();
        context.moveTo(first.x, first.y);
        if (rest.length === 0) {
          context.arc(first.x, first.y, stroke.radius, 0, Math.PI * 2);
          context.fill();
        } else {
          rest.forEach(point => context.lineTo(point.x, point.y));
          context.stroke();
        }
      });
      undo.disabled = strokes.length === 0;
      clear.disabled = strokes.length === 0;
      updateConfirm();
    };
    const finish = (result: RegionRedrawSelection | null): void => {
      if (settled) return;
      settled = true;
      endSession();
      abortController.abort();
      loaded?.revoke?.();
      overlay.remove();
      resolve(result);
    };
    endSession = beginRegionEditorSession(input.signal, () => finish(null));
    const canvasPoint = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      };
    };
    const endStroke = (event: PointerEvent): void => {
      if (activePointerId !== event.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activePointerId = null;
      activePoints = null;
      draw();
    };

    canvas.addEventListener(
      'pointerdown',
      event => {
        if (!loaded || activePointerId !== null) return;
        event.preventDefault();
        activePointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
        activePoints = [canvasPoint(event)];
        const rect = canvas.getBoundingClientRect();
        const displayedRadius = Number(brush.value) / 2;
        strokes.push({ points: activePoints, radius: displayedRadius * (canvas.width / Math.max(1, rect.width)) });
        draw();
      },
      { signal },
    );
    canvas.addEventListener(
      'pointermove',
      event => {
        if (activePointerId !== event.pointerId || !activePoints) return;
        event.preventDefault();
        activePoints.push(canvasPoint(event));
        draw();
      },
      { signal },
    );
    canvas.addEventListener('pointerup', endStroke, { signal });
    canvas.addEventListener('pointercancel', endStroke, { signal });
    prompt.addEventListener('input', updateConfirm, { signal });
    undo.addEventListener(
      'click',
      () => {
        strokes = strokes.slice(0, -1);
        draw();
      },
      { signal },
    );
    clear.addEventListener(
      'click',
      () => {
        strokes = [];
        draw();
      },
      { signal },
    );
    cancel.addEventListener('click', () => finish(null), { signal });
    overlay.addEventListener('pointerdown', event => event.target === overlay && finish(null), { signal });
    hostDocument.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape') finish(null);
      },
      { signal },
    );
    confirm.addEventListener(
      'click',
      () => {
        const region = normalizeRegionBounds(bounds(), canvas.width, canvas.height);
        if (!loaded || !region || !prompt.value.trim()) return;
        try {
          finish({ prompt: prompt.value.trim(), markedImage: canvas.toDataURL('image/png'), region });
        } catch {
          error.textContent = '无法导出标记图，请检查原图访问权限后重试。';
        }
      },
      { signal },
    );

    loadEditorImage(input.imageUrl)
      .then(result => {
        if (settled) {
          result.revoke?.();
          return;
        }
        loaded = result;
        canvas.width = result.image.naturalWidth;
        canvas.height = result.image.naturalHeight;
        canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
        draw();
        canvas.focus();
      })
      .catch(loadError => {
        if (settled) return;
        error.textContent = '原图加载失败，无法进行区域重绘。';
        confirm.disabled = true;
        void loadError;
      });
  });
}
