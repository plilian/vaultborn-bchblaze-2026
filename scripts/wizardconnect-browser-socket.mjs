export default class WizardConnectBrowserSocket extends WebSocket {
  send(data) {
    // The relay client schedules a subscription CLOSE just before shutting its
    // socket down. Chromium reports sends queued past shutdown as page errors.
    if (this.readyState >= WebSocket.CLOSING && typeof data === 'string' && data.startsWith('["CLOSE",')) return;
    super.send(data);
  }
}
