import { afterEach, expect, jest, test } from "bun:test";
import { FakeSocket } from "../../test/fake-slack.ts";
import { HEARTBEAT_MS, SlackSocket } from "./slack-socket.ts";

afterEach(() => {
  jest.useRealTimers();
});

test("a connection that stops answering pings is dropped and opened again", async () => {
  jest.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const lost: unknown[] = [];
  const events: unknown[] = [];
  const socket = new SlackSocket(
    async () => "wss://slack.test",
    {
      hello: (refreshed) => events.push(refreshed),
      event: (event) => events.push(event),
      interaction: (payload) => events.push(payload),
      lost: (error) => lost.push(error),
    },
    () => {
      const fake = new FakeSocket();
      sockets.push(fake);
      return fake;
    }
  );
  socket.start();
  await Promise.resolve();

  // A live connection answers each ping and stays.
  jest.advanceTimersByTime(HEARTBEAT_MS * 3);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.pings).toBe(3);

  // The network drops without a word: the next ping gets no pong, and the one after drops the connection.
  sockets[0]!.answers = false;
  jest.advanceTimersByTime(HEARTBEAT_MS * 2);
  expect(sockets[0]!.closed).toBe(true);
  expect(lost).toHaveLength(1);
  jest.advanceTimersByTime(1000);
  await Promise.resolve();
  expect(sockets).toHaveLength(2);
  expect(events).toEqual([]);
  socket.close();
});
