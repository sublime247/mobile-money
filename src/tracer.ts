import tracer from "dd-trace";

tracer.init({
  logInjection: true,
  env: process.env.NODE_ENV || "development",
  service: "mobile-money",
});

export default tracer;
