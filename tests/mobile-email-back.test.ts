import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { createMemoryRouter, RouterProvider } from "react-router";
import { useMobileEmailBack } from "../app/hooks/useMobileEmailBack";
import { useUIStore } from "../app/hooks/useUIStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Mailbox() {
	useMobileEmailBack();
	return null;
}

for (const path of ["/mailbox/test/emails/inbox", "/mailbox/test/search?q=hello"]) {
	test(`mobile Back closes the email before leaving ${path}`, async () => {
		Object.assign(globalThis, { window: { matchMedia: () => ({ matches: true }) } });
		useUIStore.getState().closePanel();
		const router = createMemoryRouter([
			{ path: "/", element: null },
			{ path: "/mailbox/test/*", element: createElement(Mailbox) },
		], { initialEntries: ["/", path] });
		let view: ReturnType<typeof create>;
		try {
			await act(async () => { view = create(createElement(RouterProvider, { router })); });
			const listKey = router.state.location.key;
			await act(async () => { useUIStore.getState().selectEmail("email-1"); });
			assert.notEqual(router.state.location.key, listKey);
			await act(async () => { await router.navigate(-1); });
			assert.equal(router.state.location.key, listKey);
			assert.equal(router.state.location.pathname + router.state.location.search, path);
			assert.equal(useUIStore.getState().selectedEmailId, null);
			await act(async () => { await router.navigate(1); });
			assert.equal(useUIStore.getState().selectedEmailId, "email-1");
			await act(async () => { useUIStore.getState().selectEmail("email-2"); });
			await act(async () => { useUIStore.getState().closePanel(); });
			assert.equal(router.state.location.pathname + router.state.location.search, path);
			assert.equal(useUIStore.getState().selectedEmailId, null);
			await act(async () => { await router.navigate(-1); });
			assert.equal(router.state.location.pathname, "/");
		} finally {
			await act(async () => { view?.unmount(); });
			router.dispose();
		}
	});
}

test("desktop Back and explicit navigation retain normal routing", async () => {
	for (const mobile of [false, true]) {
		Object.assign(globalThis, { window: { matchMedia: () => ({ matches: mobile }) } });
		useUIStore.getState().closePanel();
		const router = createMemoryRouter([
			{ path: "/", element: null },
			{ path: "/mailbox/test/*", element: createElement(Mailbox) },
		], { initialEntries: ["/", "/mailbox/test/emails/inbox"] });
		let view: ReturnType<typeof create>;
		try {
			await act(async () => { view = create(createElement(RouterProvider, { router })); });
			await act(async () => { useUIStore.getState().selectEmail("email-1"); });
			await act(async () => { await router.navigate(mobile ? "/" : -1); });
			assert.equal(router.state.location.pathname, "/");
		} finally {
			await act(async () => { view?.unmount(); });
			router.dispose();
		}
	}
});
