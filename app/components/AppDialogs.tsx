import { Button, Dialog, Input } from "@cloudflare/kumo";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type DialogOptions = { title: string; description?: string; action?: string; defaultValue?: string };
type Request = DialogOptions & { kind: "confirm" | "prompt"; resolve: (value: string | null) => void };
const Context = createContext<{
	confirm: (options: DialogOptions) => Promise<boolean>;
	prompt: (options: DialogOptions) => Promise<string | null>;
} | null>(null);

export function useAppDialogs() {
	const dialogs = useContext(Context);
	if (!dialogs) throw new Error("AppDialogsProvider is required");
	return dialogs;
}

export function AppDialogsProvider({ children }: { children: React.ReactNode }) {
	const [request, setRequest] = useState<Request | null>(null);
	const [value, setValue] = useState("");
	const pending = useRef<Request | null>(null);
	const finish = useCallback((result: string | null) => {
		pending.current?.resolve(result);
		pending.current = null;
		setRequest(null);
	}, []);
	useEffect(() => () => { pending.current?.resolve(null); }, []);
	const ask = useCallback((kind: Request["kind"], options: DialogOptions) => {
		// Cancel an older request if another action opens a dialog.
		pending.current?.resolve(null);
		return new Promise<string | null>((resolve) => {
			const next = { ...options, kind, resolve };
			pending.current = next;
			setValue(options.defaultValue ?? "");
			setRequest(next);
		});
	}, []);
	const confirm = useCallback(async (options: DialogOptions) => (await ask("confirm", options)) !== null, [ask]);
	const prompt = useCallback((options: DialogOptions) => ask("prompt", options), [ask]);
	return (
		<Context.Provider value={{ confirm, prompt }}>
			{children}
			<Dialog.Root open={!!request} onOpenChange={(open) => { if (!open) finish(null); }}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">{request?.title}</Dialog.Title>
					{request?.description && <Dialog.Description className="text-sm text-kumo-subtle mb-5">{request.description}</Dialog.Description>}
					<form onSubmit={(event) => { event.preventDefault(); finish(request?.kind === "prompt" ? value.trim() : "confirmed"); }}>
						{request?.kind === "prompt" && <Input autoFocus label="URL" placeholder="https://example.com" value={value} onChange={(event) => setValue(event.target.value)} className="mb-5" />}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="secondary" autoFocus={request?.kind === "confirm"} onClick={() => finish(null)}>Cancel</Button>
							<Button type="submit" variant={request?.kind === "confirm" ? "destructive" : "primary"}>{request?.action ?? "Continue"}</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</Context.Provider>
	);
}
