// src/config/auth.js

export const cognitoConfig = {
  authority: import.meta.env.VITE_COGNITO_AUTHORITY,
  client_id: import.meta.env.VITE_COGNITO_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_APP_URI,
  logoutUrl: import.meta.env.VITE_APP_URI,
  response_type: "code",
  scope: "email openid profile",
};

export const logoutUrl = (logoutUri) => {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN;
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
  return `${domain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(
    logoutUri
  )}`;
};
