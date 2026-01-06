import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export default async function RootRedirect() {
  const cookieStore = await cookies();
  const token = cookieStore.get("id_token")?.value;
  redirect(token ? "/dashboard" : "/login");
}
