import { normalizeEvent } from './calendar.js';

export class EditorAutosave {
    constructor({ id = null, initial, save, onSaved = () => {}, onStatus = () => {}, delay = 650, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.id = id;
        this.value = structuredClone(initial);
        this.initial = JSON.stringify(initial);
        this.savedValue = id ? normalizeEvent(initial) : null;
        this.savedSignature = this.savedValue ? JSON.stringify(this.savedValue) : null;
        this.save = save;
        this.onSaved = onSaved;
        this.onStatus = onStatus;
        this.delay = delay;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.timer = null;
        this.active = null;
        this.revision = 0;
        this.closed = false;
        this.paused = false;
        this.didSave = false;
    }

    update(value) {
        if (this.closed) return;
        this.value = structuredClone(value);
        this.revision++;
        this.cancelTimer();
        if (this.paused) return;
        this.onStatus('pending');
        this.timer = this.setTimer(() => {
            this.timer = null;
            return this.saveOnce().catch(() => {});
        }, this.delay);
    }

    cancelTimer() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
    }

    async saveOnce() {
        if (this.closed || this.paused) return;
        if (this.active) await this.active;
        if (this.closed || this.paused) return;
        // Closing an untouched empty form should not create a nameless event.
        if (!this.id && JSON.stringify(this.value) === this.initial) { this.onStatus('idle'); return; }
        let value;
        try { value = normalizeEvent(this.value); }
        catch (error) { this.onStatus('invalid', error); throw error; }
        const signature = JSON.stringify(value);
        if (signature === this.savedSignature) { this.onStatus(this.didSave ? 'saved' : 'idle'); return; }
        const revision = this.revision;
        this.onStatus('saving');
        const active = (async () => {
            try {
                const result = await this.save({ ...value, ...(this.id ? { id: this.id } : {}) });
                this.id = result.savedId;
                this.savedSignature = signature;
                this.savedValue = value;
                this.didSave = true;
                this.onSaved(result, value);
                this.onStatus(this.revision === revision ? 'saved' : 'pending');
            } catch (error) {
                this.onStatus('error', error);
                throw error;
            }
        })();
        this.active = active;
        try { await active; }
        finally { if (this.active === active) this.active = null; }
    }

    async flush() {
        this.cancelTimer();
        if (this.closed) return;
        for (;;) {
            const revision = this.revision;
            await this.saveOnce();
            if (revision === this.revision || this.closed) break;
        }
        this.cancelTimer();
    }

    async pause() {
        this.paused = true;
        this.cancelTimer();
        await this.active?.catch(() => {});
    }

    resume() {
        if (this.closed) return;
        this.paused = false;
        this.update(this.value);
    }

    async discard() {
        this.closed = true;
        this.cancelTimer();
        await this.active?.catch(() => {});
    }

    dispose() { this.closed = true; this.cancelTimer(); }
}
