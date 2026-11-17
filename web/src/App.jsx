import { useCallback, useEffect, useState } from 'react';
import {
  HashRouter,
  Routes,
  Route,
  NavLink,
  useParams,
  useLocation,
} from 'react-router-dom';

import { api } from './api.js';
import { Icon } from './components/ui.jsx';
import Home from './pages/Home.jsx';
import Course from './pages/Course.jsx';
import Reader from './pages/Reader.jsx';
import Profile from './pages/Profile.jsx';

function Rail({ courses, reload }) {
  const { id } = useParams();
  const location = useLocation();
  void id;

  const active = location.pathname.match(/^\/course\/(\d+)/)?.[1];

  return (
    <nav className="rail">
      <div className="rail-brand">
        <span className="mark">✿</span>
        <span>Bloom</span>
      </div>

      <NavLink to="/" className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}>
        <Icon name="plus" size={15} />
        New course
      </NavLink>
      <NavLink to="/profile" className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}>
        <Icon name="chart" size={15} />
        Progress
      </NavLink>

      <div className="rail-section">Courses</div>
      <div className="rail-courses">
        {courses.length === 0 && (
          <div className="rail-foot">Nothing yet. Start one above.</div>
        )}
        {courses.map((c) => (
          <NavLink
            key={c.id}
            to={`/course/${c.id}`}
            className={`rail-course ${active === String(c.id) ? 'active' : ''}`}
            title={c.name}
            onClick={reload}
          >
            {c.name}
          </NavLink>
        ))}
      </div>

      <div className="rail-foot">
        Powered by your Claude Code and ChatGPT subscriptions.
      </div>
    </nav>
  );
}

export default function App() {
  const [courses, setCourses] = useState([]);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState('claude-opus-5-5');
  const [model, setModel] = useState(
    () => localStorage.getItem('bloom.model') ?? '',
  );

  const reloadCourses = useCallback(() => {
    api.courses().then(setCourses).catch(() => {});
  }, []);

  useEffect(() => {
    reloadCourses();
    api
      .models()
      .then((d) => {
        setModels(d.models);
        setDefaultModel(d.default);
        setModel((prev) =>
          prev && d.models.some((m) => m.id === prev) ? prev : d.default,
        );
      })
      .catch(() => {});
  }, [reloadCourses]);

  const chooseModel = useCallback((id) => {
    setModel(id);
    localStorage.setItem('bloom.model', id);
  }, []);

  const shared = {
    models,
    model: model || defaultModel,
    setModel: chooseModel,
    courses,
    reloadCourses,
  };

  return (
    <HashRouter>
      <div className="app">
        <Rail courses={courses} reload={reloadCourses} />
        <Routes>
          <Route path="/" element={<Home {...shared} />} />
          <Route path="/course/:id" element={<Course {...shared} />} />
          <Route path="/course/:id/lesson/:num" element={<Reader {...shared} />} />
          <Route path="/profile" element={<Profile {...shared} />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
