import React from "react";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("UI crashed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: "40px",
          textAlign: "center",
          color: "#991b1b",
          background: "#fee2e2",
          borderRadius: "12px",
          margin: "40px"
        }}>
          <h2>⚠️ Something went wrong</h2>
          <p>
            The system is recovering. Please refresh or try again.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
