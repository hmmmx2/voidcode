import { Suspense } from "react";
import CreditsClient from "@/components/Credits/CreditsClient";

export const metadata = {
    title: "Credits — VoidCode AI",
    description: "Your tutor credit balance, and how to top it up",
};

/**
 * `useSearchParams` in the client component reads `?purchase=` on the way back from the payment
 * provider, and Next requires a Suspense boundary around a component that does so or the whole
 * route opts out of static rendering with a build-time error.
 */
export default function CreditsPage() {
    return (
        <Suspense fallback={null}>
            <CreditsClient />
        </Suspense>
    );
}
