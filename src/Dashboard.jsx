import React from 'react';
import './Dashboard.css'; // Add custom styles

const Dashboard = () => {
  return (
    <div className="dashboard">
      <header className="header">
        <h1>Matrix Style Dashboard</h1>
      </header>
      <main className="main-content">
        <div className="terminal">
          <h2>Trading Terminal</h2>
          <p>Current Time: 2026-03-04 17:45:11 (UTC)</p>
          <div className="charts">
            <div className="entry-chart">
              <h3>Entry Charts</h3>
              {/* Placeholder for Entry Charts */}
              <p>...</p>
            </div>
            <div className="exit-chart">
              <h3>Exit Charts</h3>
              {/* Placeholder for Exit Charts */}
              <p>...</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;