// Synthetic payload above the application's 4 MiB frame guard, never user data.
export const transportContent = `TRANSPORT_ORIGINAL_${"0123456789abcdef".repeat(330_000)}`;
