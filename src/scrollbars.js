// Inner scrollers retain their styled native thumbs. The viewport uses an
// overlay because Chromium can paint its gutter through a transparent window.
const timers = new WeakMap();

const root = document.documentElement;
const overlay = document.createElement('div');
overlay.className = 'page-scrollbar';
overlay.hidden = true;
const thumb = document.createElement('div');
thumb.className = 'page-scrollbar-thumb';
thumb.tabIndex = 0;
thumb.setAttribute('role', 'scrollbar');
thumb.setAttribute('aria-label', 'Scroll page');
thumb.setAttribute('aria-controls', 'page-content');
thumb.setAttribute('aria-orientation', 'vertical');
thumb.setAttribute('aria-valuemin', '0');
overlay.append(thumb);
document.body.append(overlay);
let frame = 0;
let drag = null;

function geometry() {
    const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
    const height = overlay.clientHeight;
    const thumbHeight = Math.min(height, Math.max(28, height * root.clientHeight / root.scrollHeight));
    return { maximum, thumbHeight, travel: Math.max(0, height - thumbHeight) };
}

function update() {
    frame = 0;
    overlay.hidden = root.scrollHeight <= root.clientHeight;
    if (overlay.hidden) return;
    const { maximum, thumbHeight, travel } = geometry();
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${maximum ? root.scrollTop / maximum * travel : 0}px)`;
    thumb.setAttribute('aria-valuemax', String(maximum));
    thumb.setAttribute('aria-valuenow', String(Math.round(root.scrollTop)));
}

function queueUpdate() {
    if (!frame) frame = requestAnimationFrame(update);
}

document.addEventListener('scroll', event => {
    const target = event.target === document ? document.documentElement : event.target;
    if (!(target instanceof Element)) return;
    target.classList.add('is-scrolling');
    clearTimeout(timers.get(target));
    timers.set(target, setTimeout(() => {
        target.classList.remove('is-scrolling');
        timers.delete(target);
    }, 800));
    if (target === root) queueUpdate();
}, { capture: true, passive: true });

overlay.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { maximum, thumbHeight, travel } = geometry();
    if (!travel || !maximum) return;
    if (event.target !== thumb) {
        root.scrollTop = (event.clientY - overlay.getBoundingClientRect().top - thumbHeight / 2) / travel * maximum;
    }
    drag = { y: event.clientY, top: root.scrollTop };
    overlay.classList.add('is-dragging');
    overlay.setPointerCapture(event.pointerId);
});
overlay.addEventListener('pointermove', event => {
    if (!drag) return;
    const { maximum, travel } = geometry();
    if (travel) root.scrollTop = drag.top + (event.clientY - drag.y) / travel * maximum;
});
function stopDragging() {
    drag = null;
    overlay.classList.remove('is-dragging');
}
overlay.addEventListener('pointerup', stopDragging);
overlay.addEventListener('pointercancel', stopDragging);
overlay.addEventListener('lostpointercapture', stopDragging);
thumb.addEventListener('keydown', event => {
    const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
    const offsets = { ArrowUp: -40, ArrowDown: 40, PageUp: -root.clientHeight * .9, PageDown: root.clientHeight * .9 };
    if (event.key in offsets) root.scrollTop += offsets[event.key];
    else if (event.key === 'Home') root.scrollTop = 0;
    else if (event.key === 'End') root.scrollTop = maximum;
    else return;
    event.preventDefault();
});
window.addEventListener('resize', queueUpdate);
new ResizeObserver(queueUpdate).observe(document.body);
update();
