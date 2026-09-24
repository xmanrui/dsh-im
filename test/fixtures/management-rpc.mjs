/** Exercise channel handlers through their registered Fetch route and RPC envelope. */
export function managementFetch(onRegister) {
  return {
    register(route) {
      const channel = route.path.slice('/api/dsh-im'.length);
      const handler = async (method, payload, signal, headers = {}) => {
        const response = await route.fetch(new Request(`http://dsh.internal${route.path}`, {
          method: 'POST',
          headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'test-call',
            method: route.path.slice('/api/'.length), payload: { method, payload },
          }),
          signal,
        }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).result;
      };
      return onRegister(channel, handler, route);
    },
  };
}
