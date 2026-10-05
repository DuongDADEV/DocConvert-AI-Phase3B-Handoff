import React, { useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';
import { UploadModal } from './components/upload/UploadModal';
import { LoadingSpinner } from './components/common/LoadingSpinner';

// Pages
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { PricingPage } from './pages/PricingPage';
import { AccountPage } from './pages/AccountPage';

function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<string>('landing');
  const [selectedDocId, setSelectedDocId] = useState<string | undefined>(undefined);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [resumeDocId, setResumeDocId] = useState<string | undefined>(undefined);

  // Synchronize auth state and tab navigation
  React.useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated && (currentTab === 'landing' || currentTab === 'login' || currentTab === 'register')) {
        setCurrentTab('dashboard');
      } else if (!isAuthenticated && (currentTab === 'dashboard' || currentTab === 'documents' || currentTab === 'account')) {
        setCurrentTab('login');
      }
    }
  }, [isAuthenticated, isLoading, currentTab]);

  const handleNavigate = (tab: string, docId?: string) => {
    setSelectedDocId(docId);
    // Protected route check (check both reactive auth state and synchronous token presence)
    const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('docconvert_token');
    const isAuthed = isAuthenticated || hasToken;
    if (!isAuthed && (tab === 'dashboard' || tab === 'documents' || tab === 'account')) {
      setCurrentTab('login');
    } else if (isAuthed && (tab === 'login' || tab === 'register')) {
      setCurrentTab('dashboard');
    } else {
      setCurrentTab(tab);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenUpload = (resumeId?: string) => {
    const cleanId = typeof resumeId === 'string' && resumeId.trim() !== '' && resumeId !== '[object Object]'
      ? resumeId.trim()
      : undefined;
    setResumeDocId(cleanId);
    setIsUploadOpen(true);
  };

  const handleCloseUpload = () => {
    setIsUploadOpen(false);
    setResumeDocId(undefined);
  };

  const handleUploadSuccess = (docId: string) => {
    setSelectedDocId(docId);
    setCurrentTab('documents');
  };

  if (isLoading) {
    return <LoadingSpinner message="Đang khởi tạo phiên làm việc bảo mật..." fullScreen />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 font-sans text-slate-900 selection:bg-blue-600 selection:text-white">
      {/* Top Navigation */}
      <Navbar
        currentTab={currentTab}
        onNavigate={handleNavigate}
        onOpenUpload={() => handleOpenUpload()}
      />

      {/* Main Page View */}
      <main className="flex-1">
        {currentTab === 'landing' && <LandingPage onNavigate={handleNavigate} />}
        {currentTab === 'login' && <LoginPage onNavigate={handleNavigate} />}
        {currentTab === 'register' && <RegisterPage onNavigate={handleNavigate} />}
        {currentTab === 'dashboard' && (
          <DashboardPage
            onNavigate={handleNavigate}
            onOpenUpload={(resumeId) => handleOpenUpload(resumeId)}
          />
        )}
        {currentTab === 'documents' && (
          <DocumentsPage
            onOpenUpload={(resumeId) => handleOpenUpload(resumeId)}
            selectedDocId={selectedDocId}
          />
        )}
        {currentTab === 'pricing' && <PricingPage onNavigate={handleNavigate} />}
        {currentTab === 'account' && <AccountPage onNavigate={handleNavigate} />}
      </main>

      {/* Global Footer */}
      <Footer />

      {/* Upload Modal (Global) */}
      <UploadModal
        isOpen={isUploadOpen}
        resumeDocumentId={resumeDocId}
        onClose={handleCloseUpload}
        onSuccess={handleUploadSuccess}
      />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
