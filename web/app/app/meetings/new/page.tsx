import { NewMeetingForm } from "./NewMeetingForm";

export default function NewMeetingPage() {
  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New meeting</h1>
        <p className="text-sm text-muted-foreground">
          Give it a title, add the people attending, and press record when
          everyone&rsquo;s ready.
        </p>
      </div>
      <NewMeetingForm />
    </div>
  );
}
