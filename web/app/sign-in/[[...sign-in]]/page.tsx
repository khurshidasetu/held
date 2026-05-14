import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="page-fade flex-1 flex items-center justify-center px-6 py-12">
      <SignIn />
    </main>
  );
}
