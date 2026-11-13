import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useUIStore } from "./useUIStore";

interface MobileEmailState {
	mobileEmail?: { id: string };
}

/** Give the full-screen mobile email a real history entry, including Forward support. */
export function useMobileEmailBack() {
	const location = useLocation();
	const navigate = useNavigate();

	useEffect(() => {
		const email = (location.state as MobileEmailState | null)?.mobileEmail;
		const isMobile = () => window.matchMedia("(max-width: 767px)").matches;
		if (email) {
			useUIStore.getState().selectEmail(email.id);
		} else if (isMobile()) {
			useUIStore.getState().closePanel();
		}

		// Listen to user actions separately from location changes so Back/Forward
		// restores the panel without creating another history entry.
		return useUIStore.subscribe((state, previous) => {
			if (state.selectedEmailId === previous.selectedEmailId || !isMobile()) return;
			if (state.selectedEmailId) {
				void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
					replace: Boolean(email),
					state: {
						...location.state,
						mobileEmail: {
							id: state.selectedEmailId,
						},
					},
				});
			} else if (email && !state.isComposing) {
				// The toolbar close action consumes the same entry as browser Back.
				void navigate(-1);
			}
		});
	}, [location, navigate]);
}
