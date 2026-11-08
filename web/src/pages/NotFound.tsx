import { ButtonLink, EmptyState } from "../components/ui.tsx";

export default function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <EmptyState title="Nothing here" body="That page does not exist." action={<ButtonLink to="/app">Back to Home</ButtonLink>} />
    </div>
  );
}
