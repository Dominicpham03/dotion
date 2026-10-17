import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, createHashRouter, Navigate, RouterProvider, type RouteObject } from "react-router-dom";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { DayPage } from "@/features/day/DayPage";
import { EntryPage, NewDatabase } from "@/features/entry/EntryPage";
import { Login } from "@/features/onboarding/Login";
import { Welcome } from "@/features/onboarding/Welcome";
import { SearchPage } from "@/features/search/SearchPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { TemplatesPage } from "@/features/templates/TemplatesPage";
import { AuthRequired } from "@/platform/types";
import { store } from "@platform";
import { Layout } from "./Layout";

const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Navigate to="/today" replace /> },
      { path: "/today", element: <DayPage /> },
      { path: "/day/:date", element: <DayPage /> },
      { path: "/entry/:id", element: <EntryPage /> },
      { path: "/calendar/:month?", element: <CalendarPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/templates", element: <TemplatesPage /> },
      { path: "/new-database", element: <NewDatabase /> },
    ],
  },
  store.platform !== "web" ? { path: "/welcome", element: <Welcome /> } : { path: "/login", element: <Login /> },
  { path: "*", element: <Navigate to="/today" replace /> },
];

// Real URLs on the web (the server's SPA fallback handles reloads); hash URLs
// inside the desktop and Android WebViews, which have no server paths.
const router = store.platform !== "web" ? createHashRouter(routes) : createBrowserRouter(routes);

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof AuthRequired && !location.pathname.startsWith("/login")) void router.navigate("/login");
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: store.platform === "web", // keeps a background tab current
      retry: (count, err) => !(err instanceof AuthRequired) && count < 2,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
