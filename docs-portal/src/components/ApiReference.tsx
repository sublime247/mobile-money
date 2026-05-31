import React from "react";
import { RedocStandalone } from "redoc";

export default function ApiReference(): React.JSX.Element {
  return (
    <RedocStandalone
      specUrl="/openapi.yaml"
      options={{
        hideHostname: false,
        disableSearch: false,
        expandResponses: "200,201",
        requiredPropsFirst: true,
        sortPropsAlphabetically: true,
      }}
    />
  );
}
