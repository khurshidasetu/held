import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-12">
      <SignUp />
    </main>
  );
}
