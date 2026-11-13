// Drive the real toolbar popup, including its real sender identity. Opening
// popup.html in a normal tab would exercise a different (rejected) trust path.
// Chromium exposes popup targets independently of Playwright Page objects, so
// this small driver uses the documented Target/Runtime/Input CDP domains.
export class PopupDriver {
  constructor(cdp, sessionId, targetId) {
    this.cdp=cdp;
    this.sessionId=sessionId;
    this.targetId=targetId;
    this.sequence=0;
    this.pending=new Map();
    this.listener=event => {
      if (event.sessionId!==this.sessionId) return;
      const message=JSON.parse(event.message);
      const pending=this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Popup browser command failed: ${message.error.message}`));
      else pending.resolve(message.result);
    };
    cdp.on('Target.receivedMessageFromTarget',this.listener);
  }

  static async attach(cdp,targetId) {
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:false});
    const driver=new PopupDriver(cdp,sessionId,targetId);
    await driver.command('Runtime.enable');
    return driver;
  }

  command(method,params={}) {
    const id=++this.sequence;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Popup browser command timed out: ${method}`));
      },10_000);
      this.pending.set(id,{resolve,reject,timer});
      this.cdp.send('Target.sendMessageToTarget',{
        sessionId:this.sessionId,
        message:JSON.stringify({id,method,params}),
      }).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async evaluate(expression) {
    const result=await this.command('Runtime.evaluate',{
      expression,
      returnByValue:true,
      awaitPromise:true,
    });
    // Never append the expression: form values include a disposable token.
    if (result.exceptionDetails) throw new Error('The popup DOM operation failed.');
    return result.result.value;
  }

  text(id) {
    return this.evaluate(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`);
  }

  value(id) {
    return this.evaluate(`document.getElementById(${JSON.stringify(id)})?.value ?? null`);
  }

  async fill(id,value) {
    await this.evaluate(`(() => {
      const input=document.getElementById(${JSON.stringify(id)});
      if (!input || input.disabled) throw new Error('Input unavailable');
      input.focus();
      input.value=${JSON.stringify(value)};
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
  }

  async click(id) {
    const point=await this.evaluate(`(() => {
      const element=document.getElementById(${JSON.stringify(id)});
      if (!element || element.disabled || element.hidden) throw new Error('Control unavailable');
      element.scrollIntoView({block:'center'});
      const rect=element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Control invisible');
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await this.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }

  async submitSetup() {
    // The shipped submit button has no ID. Locate it without changing the DOM.
    const point=await this.evaluate(`(() => {
      const button=document.querySelector('#setup-form button[type="submit"]');
      button.scrollIntoView({block:'center'});
      const rect=button.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await this.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }

  async close() {
    this.cdp.off('Target.receivedMessageFromTarget',this.listener);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Popup closed.'));
    }
    this.pending.clear();
    try { await this.cdp.send('Target.detachFromTarget',{sessionId:this.sessionId}); } catch { /* Already closed. */ }
    try { await this.cdp.send('Target.closeTarget',{targetId:this.targetId}); } catch { /* Already closed. */ }
  }
}
