export class SelfTestRunner {
    constructor(broadcaster) {
        this._stage = 0;
        this._broadcaster = broadcaster;
    }
    async startAsync(id, session) {
        if (this._timeoutId0)
            clearTimeout(this._timeoutId0);
        if (this._timeoutId1)
            clearTimeout(this._timeoutId1);
        if (this._timeoutId2)
            clearTimeout(this._timeoutId2);
        await session.send('Page.navigate', { url: 'file:///app/self-test/test1.html' });
        this._timeoutId0 = setTimeout(() => {
            this._stage = 0;
            console.log(`[Self test] Started for device ${id}`);
            this._broadcaster.startSelfTestMeasurement(id);
        }, 5000);
        this._timeoutId1 = setTimeout(() => {
            this._stage = 1;
            console.log(`[Self test] Partial stage finished for device ${id}`);
            this._broadcaster.startSelfTestMeasurement(id);
        }, 70000);
        this._timeoutId2 = setTimeout(() => {
            this._stage = 2;
            console.log(`[Self test] Full stage finished for device ${id}`);
            this._broadcaster.startSelfTestMeasurement(id);
        }, 125000);
    }
    async setFrameRenderTimeAsync(value, session) {
        console.log(`[Self test] Frame render time: ${value}ms`);
        switch (this._stage) {
            case 1:
                this._partial = value ?? 0;
                break;
            case 2:
                this._full = value ?? 0;
                console.log(`Self test result: partial=${this._partial}ms, full=${this._full}ms`);
                await session.send('Page.navigate', { url: `file:///app/self-test/test1.html?partial=${this._partial}&full=${this._full}` });
                break;
        }
    }
    stop() {
        if (this._timeoutId0 || this._timeoutId1 || this._timeoutId2)
            console.log(`[Self test] Stopped`);
        if (this._timeoutId0)
            clearTimeout(this._timeoutId0);
        if (this._timeoutId1)
            clearTimeout(this._timeoutId1);
        if (this._timeoutId2)
            clearTimeout(this._timeoutId2);
        this._timeoutId0 = undefined;
        this._timeoutId1 = undefined;
        this._timeoutId2 = undefined;
        this._stage = 0;
    }
}
